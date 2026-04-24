/**
 * llm-entities.ts — opt-in LLM entity extractor (Sprint 2.3 + Codex fixes).
 *
 * The default extractor in store-batch.ts uses regex on capitalised tokens —
 * fast and cheap but it splits "cousin Emily" and "friend Emily" into two
 * separate entities WITHIN one chunk, and routinely misses event-style
 * references ("the Monterey trip" → no Capital token to grab).
 *
 * This module shells out to `claude -p --model haiku` to do semantic entity
 * extraction. Opt-in via NEUROMCP_LLM_ENTITIES=1. Default OFF — adds ~1-2s
 * + ~$0.001 per memory ingested.
 *
 * Scope honesty (Codex Sprint 2.3 review Q2): this fixes alias dedup
 * WITHIN one chunk only. Cross-chunk dedup ("Emily" in row 1 vs "Emily
 * Williams" in row 2) is NOT solved here — `upsertEntity` matches on
 * exact lowercased name + type + namespace. A separate cross-row merge
 * pass (planned as Sprint 4 work) is needed for that.
 */
import { spawn } from 'node:child_process';

export interface LLMEntity {
  readonly name: string;
  readonly type: string;
}

export interface ExtractOptions {
  readonly timeoutMs?: number;
  readonly cliPath?: string;
  // Codex Sprint 2.3 Q4: cliPath is a constructor-side option only — there's
  // no user-controlled flow into it. spawn(.., {shell: false}) below means
  // even a malicious cliPath cannot achieve shell injection (no shell is
  // invoked); a misconfigured cliPath is a config bug, not a security hole.
}

/**
 * Extract entities from one chunk via Haiku CLI.
 *
 * Codex Sprint 2.3 Q1 fix: returns a Promise and uses non-blocking `spawn`
 * so the Node event loop is free during the ~3s Haiku call. Callers can
 * fan out with bounded concurrency.
 *
 * Returns [] on any failure (CLI missing, timeout, parse error). Caller may
 * fall back to regex.
 */
export async function extractEntitiesViaLLM(
  content: string,
  options: ExtractOptions = {},
): Promise<readonly LLMEntity[]> {
  const { timeoutMs = 30000, cliPath = 'claude' } = options;
  if (!content || content.trim().length === 0) return [];

  // Codex Sprint 2.3 Q5 fix: head+tail cap, not head-only. Long sessions
  // hide late "by the way that's my sister X" reveals in the second half.
  // 5K head + 3K tail keeps the budget at 8K with a marker between.
  const capped = capContent(content, 5000, 3000);

  const prompt =
    'Extract NAMED ENTITIES from this conversation chunk.\n\n' +
    'Rules:\n' +
    '- Include: people (with relationship if stated), places, organisations, ' +
    'product names, named events.\n' +
    '- Deduplicate aliases WITHIN this chunk: "cousin Emily", "friend Emily", ' +
    '"Emily Williams" all refer to ONE entity — pick the most informative form.\n' +
    '- EXCLUDE: pronouns, generic nouns ("the city"), common stop-words.\n' +
    '- Type must be one of: person, place, org, product, event.\n\n' +
    'Output STRICT JSON only — no prose, no fences. Format:\n' +
    '{"entities":[{"name":"<canonical name>","type":"<person|place|org|product|event>"}]}\n\n' +
    'Conversation:\n' +
    capped;

  let stdout: string;
  try {
    stdout = await runCli(cliPath, ['-p', '--model', 'haiku'], prompt, timeoutMs);
  } catch {
    return [];
  }
  if (!stdout) return [];
  return parseEntitiesPayload(stdout);
}

function capContent(content: string, headLen: number, tailLen: number): string {
  if (content.length <= headLen + tailLen) return content;
  return content.slice(0, headLen) + '\n\n[…truncated…]\n\n' + content.slice(-tailLen);
}

/**
 * Spawn the CLI without a shell, pipe prompt to stdin, await stdout.
 * Rejects on timeout or non-zero exit.
 */
function runCli(
  cli: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      // shell: false (default) — no shell injection possible even with a
      // hostile cliPath; the binary is invoked directly.
      proc = spawn(cli, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(() => reject(new Error(`cli timeout after ${timeoutMs}ms: ${cli}`)));
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      finish(() => reject(err));
    });
    proc.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`cli exit ${code}: ${stderr.slice(0, 200)}`));
        } else {
          resolve(stdout);
        }
      });
    });

    try {
      proc.stdin?.write(input);
      proc.stdin?.end();
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/**
 * Parse the Haiku output into the entity list. Robust to the model wrapping
 * the JSON in code fences or adding stray prose around it.
 */
export function parseEntitiesPayload(text: string): readonly LLMEntity[] {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  // Try the cleaned text directly first.
  const candidates: string[] = [cleaned];
  // Bracket-matched slice: from first '{' to its matching '}' counted by depth.
  const sliced = sliceFirstJSONObject(cleaned);
  if (sliced && sliced !== cleaned) candidates.push(sliced);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      const entities = (parsed as { entities?: unknown }).entities;
      if (Array.isArray(entities)) {
        return entities
          .map((e) => normaliseEntity(e))
          .filter((e): e is LLMEntity => e !== null);
      }
    } catch {
      // try next candidate
    }
  }
  return [];
}

function sliceFirstJSONObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const VALID_TYPES = new Set(['person', 'place', 'org', 'product', 'event', 'name']);

function normaliseEntity(raw: unknown): LLMEntity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name || name.length > 80) return null;
  let type = typeof o.type === 'string' ? o.type.trim().toLowerCase() : 'name';
  if (!VALID_TYPES.has(type)) type = 'name';
  return { name, type };
}
