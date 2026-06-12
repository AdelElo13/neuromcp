/**
 * validate.ts — startup compatibility check between the active embedding
 * provider and the embeddings already persisted in this database.
 *
 * Two silent-corruption modes this prevents:
 *
 * 1. DIMENSION MISMATCH. memories_vec is created with a fixed float[N]
 *    column. `CREATE VIRTUAL TABLE IF NOT EXISTS` means an existing index
 *    keeps its old dimension when the provider changes (e.g. the 'auto'
 *    cascade silently falling from Ollama 768-dim to the ONNX 384-dim
 *    fallback because Ollama was down at startup) — after which every vec
 *    upsert/search fails or, worse, compares incompatible vectors.
 *
 * 2. MODEL MIX AT SAME DIMENSION. Two different models can share a
 *    dimension; their vector spaces are unrelated, so similarity scores
 *    against old vectors become noise. embedding_model is recorded on every
 *    memory but was never validated against the active provider.
 *
 * Both fail loudly at startup with a remediation hint instead of degrading
 * recall silently. Escape hatch for intentional migrations:
 * NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX=1.
 */
import type Database from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';
import type { EmbeddingProvider } from './types.js';

/** Read the dimension of an existing memories_vec table, or null if absent. */
export function getExistingVecDimension(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_vec'")
    .get() as { sql: string } | undefined;
  if (row === undefined) return null;
  const match = row.sql.match(/float\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

export function validateEmbeddingCompatibility(
  db: Database.Database,
  embedder: EmbeddingProvider,
  logger: Logger,
): void {
  // 1. Vector-table dimension vs provider dimension
  const existingDim = getExistingVecDimension(db);
  if (existingDim !== null && existingDim !== embedder.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: the existing vector index is ${existingDim}-dimensional ` +
        `but the active provider "${embedder.name}" produces ${embedder.dimensions}-dimensional embeddings. ` +
        `This usually means the embedding provider changed (e.g. the 'auto' cascade fell back to a different ` +
        `provider because the previous one was unavailable). Fix: restore the original provider/model ` +
        `(NEUROMCP_EMBEDDING_PROVIDER / NEUROMCP_EMBEDDING_MODEL), or re-embed everything with ` +
        `npx neuromcp-backfill-embeddings after dropping the old index.`,
    );
  }

  // 2. Same-dimension model mix
  const models = db
    .prepare(
      `SELECT embedding_model, COUNT(*) AS n FROM memories
        WHERE is_deleted = 0
          AND embedding_model IS NOT NULL
          AND embedding_model NOT IN ('none', '')
        GROUP BY embedding_model`,
    )
    .all() as Array<{ embedding_model: string; n: number }>;

  const foreign = models.filter((m) => m.embedding_model !== embedder.name);
  if (foreign.length > 0) {
    const detail = foreign.map((m) => `"${m.embedding_model}" (${m.n} memories)`).join(', ');
    if (process.env['NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX'] === '1') {
      logger.warn('embeddings', 'Embedding model mix allowed by override', {
        active: embedder.name,
        stored: detail,
      });
      return;
    }
    throw new Error(
      `Embedding model mismatch: this database contains memories embedded with ${detail}, ` +
        `but the active provider is "${embedder.name}". Different models produce unrelated vector spaces — ` +
        `mixing them silently turns similarity scores into noise. Fix: restore the original model ` +
        `(NEUROMCP_EMBEDDING_PROVIDER / NEUROMCP_EMBEDDING_MODEL), re-embed with ` +
        `npx neuromcp-backfill-embeddings, or set NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX=1 if this mix is intentional.`,
    );
  }
}
