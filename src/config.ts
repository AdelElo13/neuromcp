import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface NeuromcpConfig {
  readonly dbPath: string;
  readonly maxDbSizeMb: number;
  readonly embeddingProvider: 'auto' | 'onnx' | 'ollama' | 'openai';
  readonly embeddingModel: string;
  readonly ollamaHost: string;
  readonly embeddingUrl: string | null;
  readonly defaultNamespace: string;
  readonly tombstoneTtlDays: number;
  readonly autoConsolidate: boolean;
  readonly consolidateIntervalHours: number;
  readonly decayLambda: number;
  readonly dedupThreshold: number;
  readonly minImportance: number;
  readonly autoCommitSimilarity: number;
  readonly sweepIntervalHours: number;
  readonly claudeCodeIntegration: 'auto' | 'enabled' | 'disabled';
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly logFormat: 'text' | 'json';
  // Phase 3: Contradiction
  readonly contradictionThreshold: number;
  // Phase 4: Cognitive
  readonly surpriseDecayDays: number;
  readonly primingBoost: number;
  readonly mmrLambda: number;
  // HTTP transport
  readonly httpEnabled: boolean;
  readonly httpPort: number;
  readonly httpHost: string;
  // Adaptive importance
  readonly accessBoost: number;
  readonly recencyBoost: number;
  readonly centralityBoost: number;
  // Attention-based retrieval (AttnRes-inspired)
  readonly attentionWeight: number;
  readonly blockAttentionWeight: number;
  // Usefulness prior (v0.17.x). Gate explorative sampling behind a
  // minimum observation threshold, and cap the multiplicative range so
  // the prior is a tiebreaker rather than a dominator.
  readonly usefulnessExplorationThreshold: number;
  readonly usefulnessFactorRange: number;
  // Embedding HTTP timeout (ms) — a hung Ollama/OpenAI must not block
  // store/search (and startup) indefinitely.
  readonly embedTimeoutMs: number;
  // Entity extraction
  readonly entityExtractionMode: 'auto' | 'llm' | 'regex';
  readonly ollamaChatModel: string;
  // Wiki
  readonly wikiDir: string;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig(): NeuromcpConfig {
  const defaultDbPath = resolve(homedir(), '.neuromcp', 'memory.db');
  return {
    dbPath: env('NEUROMCP_DB_PATH', defaultDbPath),
    maxDbSizeMb: envNum('NEUROMCP_MAX_DB_SIZE_MB', 500),
    embeddingProvider: env('NEUROMCP_EMBEDDING_PROVIDER', 'auto') as NeuromcpConfig['embeddingProvider'],
    embeddingModel: env('NEUROMCP_EMBEDDING_MODEL', 'auto'),
    ollamaHost: env('OLLAMA_HOST', 'http://localhost:11434'),
    embeddingUrl: process.env['NEUROMCP_EMBEDDING_URL'] ?? null,
    defaultNamespace: env('NEUROMCP_DEFAULT_NAMESPACE', 'default'),
    tombstoneTtlDays: envNum('NEUROMCP_TOMBSTONE_TTL_DAYS', 30),
    autoConsolidate: envBool('NEUROMCP_AUTO_CONSOLIDATE', false),
    consolidateIntervalHours: envNum('NEUROMCP_CONSOLIDATE_INTERVAL_HOURS', 24),
    decayLambda: envNum('NEUROMCP_DECAY_LAMBDA', 0.01),
    dedupThreshold: envNum('NEUROMCP_DEDUP_THRESHOLD', 0.92),
    minImportance: envNum('NEUROMCP_MIN_IMPORTANCE', 0.05),
    autoCommitSimilarity: envNum('NEUROMCP_AUTO_COMMIT_SIMILARITY', 0.95),
    sweepIntervalHours: envNum('NEUROMCP_SWEEP_INTERVAL_HOURS', 6),
    claudeCodeIntegration: env('NEUROMCP_CLAUDE_CODE_INTEGRATION', 'auto') as NeuromcpConfig['claudeCodeIntegration'],
    logLevel: env('NEUROMCP_LOG_LEVEL', 'info') as NeuromcpConfig['logLevel'],
    logFormat: env('NEUROMCP_LOG_FORMAT', 'text') as NeuromcpConfig['logFormat'],
    contradictionThreshold: envNum('NEUROMCP_CONTRADICTION_THRESHOLD', 0.82),
    surpriseDecayDays: envNum('NEUROMCP_SURPRISE_DECAY_DAYS', 7),
    primingBoost: envNum('NEUROMCP_PRIMING_BOOST', 0.15),
    mmrLambda: envNum('NEUROMCP_MMR_LAMBDA', 0.7),
    httpEnabled: envBool('NEUROMCP_HTTP_ENABLED', false),
    httpPort: envNum('NEUROMCP_HTTP_PORT', 3200),
    httpHost: env('NEUROMCP_HTTP_HOST', '127.0.0.1'),
    accessBoost: envNum('NEUROMCP_ACCESS_BOOST', 0.05),
    recencyBoost: envNum('NEUROMCP_RECENCY_BOOST', 0.1),
    centralityBoost: envNum('NEUROMCP_CENTRALITY_BOOST', 0.15),
    attentionWeight: envNum('NEUROMCP_ATTENTION_WEIGHT', 0.004),
    blockAttentionWeight: envNum('NEUROMCP_BLOCK_ATTENTION_WEIGHT', 0.003),
    usefulnessExplorationThreshold: envNum('NEUROMCP_USEFULNESS_EXPLORATION_THRESHOLD', 3),
    usefulnessFactorRange: envNum('NEUROMCP_USEFULNESS_FACTOR_RANGE', 0.5),
    embedTimeoutMs: envNum('NEUROMCP_EMBED_TIMEOUT_MS', 30_000),
    // Default 'regex': the write path must stay LLM-free (store_memory used
    // to block up to 15s on an Ollama /api/chat call per store). 'auto' and
    // 'llm' remain available as explicit opt-ins.
    entityExtractionMode: env('NEUROMCP_ENTITY_EXTRACTION', 'regex') as NeuromcpConfig['entityExtractionMode'],
    ollamaChatModel: env('NEUROMCP_OLLAMA_CHAT_MODEL', 'llama3.2:3b'),
    wikiDir: env('NEUROMCP_WIKI_DIR', resolve(homedir(), '.neuromcp', 'wiki')),
  };
}
