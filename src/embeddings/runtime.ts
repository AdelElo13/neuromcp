/**
 * runtime.ts — decide WHICH embedding provider this process runs with,
 * given the vector index that already exists in the database.
 *
 * The 0.29.2 behaviour was: build a provider from the cascade, then call
 * validateEmbeddingCompatibility() and die on a mismatch. That turns two
 * ordinary events into a server that will not boot at all:
 *
 *   - installing Ollama after the ONNX fallback already built a 384-dim
 *     index (provider jumps to 768 → "Embedding dimension mismatch"),
 *   - Ollama being down for a minute on a 768-dim index (the 'auto'
 *     cascade falls to ONNX 384 → same crash, and it keeps crashing after
 *     Ollama comes back up only if the fallback already wrote vectors).
 *
 * 0.29.3 resolves the provider against the index instead:
 *
 *   1. No index yet → unchanged behaviour (first provider from the cascade).
 *   2. Index exists → only accept a provider whose width matches it. That
 *      means "Ollama is installed now" keeps using ONNX 384 until the user
 *      deliberately re-embeds, instead of crashing.
 *   3. Nothing matching is reachable → retry the cascade with exponential
 *      backoff (Ollama may still be starting), then start in DEGRADED mode:
 *      full-text search keeps working, vector search is disabled, new
 *      memories are stored WITHOUT a vector (queued for the next
 *      backfill_embeddings run). Never throws.
 *
 * The degraded state is visible in three places: a loud stderr banner, the
 * `neuromcp_notice` field on store_memory / search_memory results, and
 * `memory_stats.embeddings`. `neuromcp-doctor check` names it too.
 *
 * Escape hatch: NEUROMCP_STRICT_EMBEDDINGS=1 restores the old
 * crash-on-mismatch behaviour for people who prefer a hard stop.
 */
import type Database from 'better-sqlite3';
import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { EmbeddingProvider } from './types.js';
import { createEmbeddingProvider, selectEmbeddingProvider } from './factory.js';
import {
  getExistingVecDimension,
  getStoredEmbeddingModels,
  validateEmbeddingCompatibility,
} from './validate.js';

/** Thrown by the degraded provider. Callers treat it as "skip the vector". */
export class EmbeddingsUnavailableError extends Error {
  readonly code = 'EMBEDDINGS_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsUnavailableError';
  }
}

export function isEmbeddingsUnavailable(err: unknown): err is EmbeddingsUnavailableError {
  return err instanceof EmbeddingsUnavailableError;
}

/**
 * Stand-in provider used in degraded mode. It reports the width of the
 * EXISTING index so the vector table is never recreated at another width,
 * and refuses to embed so no unrelated vector can enter the index.
 */
export class DegradedEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly dimensions: number;
  readonly maxTokens = 0;
  readonly degraded = true;
  readonly reason: string;

  constructor(dimensions: number, reason: string) {
    this.dimensions = dimensions;
    this.reason = reason;
  }

  async embed(): Promise<Float32Array> {
    throw new EmbeddingsUnavailableError(this.reason);
  }

  async embedBatch(): Promise<Float32Array[]> {
    throw new EmbeddingsUnavailableError(this.reason);
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}

/** True when this provider is the degraded stand-in. */
export function isDegradedProvider(embedder: EmbeddingProvider): boolean {
  return (embedder as { degraded?: boolean }).degraded === true;
}

/**
 * Tool-visible one-liner, or null when embeddings are healthy. Attached to
 * store_memory / search_memory results so the agent using neuromcp can SEE
 * that vector search is off instead of silently getting keyword-only recall.
 */
export function degradedNotice(embedder: EmbeddingProvider): string | null {
  if (!isDegradedProvider(embedder)) return null;
  return (
    'neuromcp is running in DEGRADED mode: vector search is disabled and new memories are stored ' +
    'without embeddings (they are queued for backfill_embeddings). Full-text search still works. ' +
    `Reason: ${(embedder as DegradedEmbeddingProvider).reason} ` +
    'Recovery: run `npx neuromcp-doctor check` for the exact steps.'
  );
}

/**
 * Machine-readable embedding health, surfaced by memory_stats so a degraded
 * install can be detected from inside a client session.
 */
export function embeddingStatus(
  db: Database.Database,
  embedder: EmbeddingProvider,
): Record<string, unknown> {
  const degraded = isDegradedProvider(embedder);
  let indexDimension: number | null = null;
  try {
    indexDimension = getExistingVecDimension(db);
  } catch {
    /* index table unreadable — reported as null */
  }
  let unembedded = 0;
  try {
    unembedded = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
            WHERE is_deleted = 0
              AND (embedding_model IS NULL OR embedding_model IN ('none', ''))`,
        )
        .get() as { n: number }
    ).n;
  } catch {
    /* pre-schema-14 database — leave at 0 */
  }
  return {
    status: degraded ? 'degraded' : 'ok',
    vector_search: degraded ? 'disabled' : 'enabled',
    provider: degraded ? null : embedder.name,
    provider_dimensions: degraded ? null : embedder.dimensions,
    index_dimensions: indexDimension,
    memories_without_embedding: unembedded,
    message: degradedNotice(embedder),
  };
}

export interface EmbeddingRuntime {
  readonly embedder: EmbeddingProvider;
  /** 'fresh' = no index yet, 'matched' = provider matches the index, 'degraded' = no usable provider. */
  readonly mode: 'fresh' | 'matched' | 'degraded';
  readonly vectorEnabled: boolean;
  readonly indexDimension: number | null;
  readonly message: string | null;
}

export interface ResolveDeps {
  /** Retry passes over the cascade before degrading (default 3). */
  readonly attempts?: number;
  /** First backoff delay in ms; doubles per attempt (default 500). */
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: { write: (s: string) => unknown };
  /** Injectable provider cascade — tests use it to avoid network probes. */
  readonly select?: typeof selectEmbeddingProvider;
  /** Injectable strict-path factory for the fresh-database branch. */
  readonly create?: typeof createEmbeddingProvider;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function resolveEmbeddingRuntime(
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  deps: ResolveDeps = {},
): Promise<EmbeddingRuntime> {
  const {
    env = process.env,
    sleep = defaultSleep,
    stderr = process.stderr,
    select = selectEmbeddingProvider,
    create = createEmbeddingProvider,
  } = deps;
  const attempts = deps.attempts ?? envInt(env, 'NEUROMCP_EMBEDDING_RETRY_ATTEMPTS', 3);
  const baseDelayMs = deps.baseDelayMs ?? envInt(env, 'NEUROMCP_EMBEDDING_RETRY_BASE_MS', 500);
  const strict = env['NEUROMCP_STRICT_EMBEDDINGS'] === '1';

  const indexDimension = getExistingVecDimension(db);

  // ── Case 1: no vector index yet. Nothing to be compatible with. ───────
  if (indexDimension === null) {
    const embedder = await create(config, logger);
    validateEmbeddingCompatibility(db, embedder, logger, env);
    return { embedder, mode: 'fresh', vectorEnabled: true, indexDimension: null, message: null };
  }

  // ── Case 2: pick the provider that matches the existing index. ────────
  // Require the stored MODEL too when it is unambiguous: a same-width
  // provider of another model must not stop the cascade — the right
  // provider may be one candidate further down (Codex round-2 finding).
  // Zero stored models (everything awaiting backfill), a historical mix,
  // or the documented NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX=1 override fall
  // back to width-only — the override must reach validation too (same env),
  // otherwise it is silently dead (Codex round-3 finding).
  const mixAllowed = env['NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX'] === '1';
  const storedModels = getStoredEmbeddingModels(db);
  const requireModel = !mixAllowed && storedModels.length === 1 ? storedModels[0] : undefined;

  let rejected: readonly string[] = [];
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const selection = await select(config, logger, {
      requireDimension: indexDimension,
      requireModel,
    });
    rejected = selection.rejected;
    if (selection.provider !== null) {
      try {
        validateEmbeddingCompatibility(db, selection.provider, logger, env);
      } catch (err) {
        // Same width, different model — vectors are unrelated. Degrade
        // rather than poison recall with noise.
        const reason = err instanceof Error ? err.message : String(err);
        if (strict) throw err;
        return degrade(indexDimension, reason, logger, stderr);
      }
      logger.info('embeddings', 'Provider matched the existing vector index', {
        provider: selection.provider.name,
        dimensions: selection.provider.dimensions,
        attempt,
      });
      return {
        embedder: selection.provider,
        mode: 'matched',
        vectorEnabled: true,
        indexDimension,
        message: null,
      };
    }
    if (attempt < Math.max(1, attempts)) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn('embeddings', 'No provider matches the vector index — retrying', {
        indexDimensions: indexDimension,
        attempt,
        retryInMs: delay,
      });
      await sleep(delay);
    }
  }

  // ── Case 3: nothing matching after the retries → degraded start. ──────
  const detail =
    rejected.length > 0
      ? `reachable providers do not match the index: ${rejected.join('; ')}.`
      : 'no embedding provider was reachable.';
  const reason = `the existing vector index is ${indexDimension}-dimensional and ${detail}`;
  if (strict) {
    throw new Error(
      `Embedding dimension mismatch: ${reason} ` +
        '(NEUROMCP_STRICT_EMBEDDINGS=1 is set, so this is fatal.) ' +
        'Fix: restore the original provider, or rebuild the index with `npx neuromcp-reembed --apply`.',
    );
  }
  return degrade(indexDimension, reason, logger, stderr);
}

function degrade(
  indexDimension: number,
  reason: string,
  logger: Logger,
  stderr: { write: (s: string) => unknown },
): EmbeddingRuntime {
  const embedder = new DegradedEmbeddingProvider(indexDimension, reason);
  logger.error('embeddings', 'DEGRADED MODE — vector search disabled', {
    indexDimensions: indexDimension,
    reason,
  });
  stderr.write(
    '\n' +
      '  ┌─ neuromcp: DEGRADED MODE ───────────────────────────────────────\n' +
      `  │ ${reason}\n` +
      '  │ Full-text search works. Vector search is DISABLED and new\n' +
      '  │ memories are stored without embeddings (queued for backfill).\n' +
      '  │ Nothing was deleted and the existing index is untouched.\n' +
      '  │\n' +
      '  │ Recovery, pick one:\n' +
      '  │  a) bring the original provider back (e.g. start Ollama, then\n' +
      '  │     `ollama pull nomic-embed-text`) and restart the client, or\n' +
      '  │  b) rebuild the index for the new provider:\n' +
      '  │       npx neuromcp-reembed            # dry run on a COPY\n' +
      '  │       npx neuromcp-reembed --apply    # swap it in (keeps a backup)\n' +
      '  │  Details: npx neuromcp-doctor check\n' +
      '  └─────────────────────────────────────────────────────────────────\n\n',
  );
  return {
    embedder,
    mode: 'degraded',
    vectorEnabled: false,
    indexDimension,
    message: reason,
  };
}
