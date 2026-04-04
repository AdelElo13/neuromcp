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
  };
}
