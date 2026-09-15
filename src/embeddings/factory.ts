import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { EmbeddingProvider } from './types.js';
import { OnnxEmbeddingProvider } from './onnx.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAIEmbeddingProvider } from './openai.js';

/**
 * Outcome of one pass over the provider cascade.
 *
 * `provider === null` means nothing usable was found. `explicitError` then
 * carries the message the strict entrypoint (createEmbeddingProvider)
 * throws; `rejected` lists providers that WERE reachable but were skipped
 * because their dimension does not match the existing vector index (see
 * `requireDimension`). The index-aware caller uses that list to explain a
 * degraded start instead of crashing.
 */
export interface ProviderSelection {
  readonly provider: EmbeddingProvider | null;
  readonly rejected: readonly string[];
  readonly explicitError: string | null;
}

export interface SelectProviderOptions {
  /**
   * Only accept a provider whose `dimensions` equal this value. Used when
   * the database already holds a vector index of a fixed width: a provider
   * with a different width cannot write into that index, and swapping it in
   * silently is exactly the corruption validate.ts exists to prevent.
   */
  readonly requireDimension?: number;
  /**
   * Only accept a provider whose `name` equals the model that produced the
   * stored embeddings. Two models can share a width while their vector
   * spaces are unrelated — without this, the cascade stopped at the first
   * width match and degraded on the model check even when the RIGHT
   * provider was one step further down.
   */
  readonly requireModel?: string;
}

export type AcceptVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Pure compatibility rule between a candidate provider and the existing
 * index. Exported so the selection cascade, its static short-circuits and
 * the tests all share ONE definition of "acceptable".
 */
export function providerAcceptable(
  provider: { readonly name: string; readonly dimensions: number },
  options: SelectProviderOptions,
): AcceptVerdict {
  if (options.requireDimension !== undefined && provider.dimensions !== options.requireDimension) {
    return {
      ok: false,
      reason:
        `${provider.name} (${provider.dimensions}d, reachable but the existing index is ` +
        `${options.requireDimension}d)`,
    };
  }
  if (options.requireModel !== undefined && provider.name !== options.requireModel) {
    return {
      ok: false,
      reason:
        `${provider.name} (${provider.dimensions}d — width matches, but the stored embeddings ` +
        `were produced by "${options.requireModel}"; mixing models turns similarity into noise)`,
    };
  }
  return { ok: true };
}

/** ONNX facts that are known WITHOUT touching disk or network. */
const ONNX_STATIC = { name: 'bge-small-en-v1.5', dimensions: 384 } as const;

/**
 * Rule the ONNX fallback out BEFORE probing it, when the requirements make
 * a match impossible. The probe is not free: with the model file absent it
 * starts a ~33 MB lazy download — pointless (and startup-delaying) when the
 * fixed 384 width can never match the existing index anyway.
 */
export function staticOnnxSkipReason(options: SelectProviderOptions): string | null {
  const verdict = providerAcceptable(ONNX_STATIC, options);
  if (verdict.ok) return null;
  return `${verdict.reason} — skipped without probing (no model download attempted)`;
}

/**
 * Walk the provider cascade (Ollama → OpenAI → ONNX) and return the first
 * usable provider. Never throws: the strict wrapper below turns a null
 * result into the historical error message, while the degraded-start path
 * in runtime.ts uses the structured result to keep the server alive.
 */
export async function selectEmbeddingProvider(
  config: NeuromcpConfig,
  logger: Logger,
  options: SelectProviderOptions = {},
): Promise<ProviderSelection> {
  const requested = config.embeddingProvider;
  const rejected: string[] = [];

  /** Accept a reachable provider only when it matches the existing index. */
  const accept = (provider: EmbeddingProvider): boolean => {
    const verdict = providerAcceptable(provider, options);
    if (verdict.ok) return true;
    rejected.push(verdict.reason);
    logger.warn('embeddings', 'Provider skipped — does not match the existing vector index', {
      provider: provider.name,
      providerDimensions: provider.dimensions,
      indexDimensions: options.requireDimension,
      requiredModel: options.requireModel,
    });
    return false;
  };

  // 1. Try Ollama first (if auto or explicitly requested) — real semantic quality
  if (requested === 'auto' || requested === 'ollama') {
    const model = config.embeddingModel === 'auto' ? 'nomic-embed-text' : config.embeddingModel;
    const ollama = new OllamaEmbeddingProvider(config.ollamaHost, model, {
      timeoutMs: config.embedTimeoutMs,
    });
    if (await ollama.isAvailable()) {
      if (accept(ollama)) {
        logger.info('embeddings', `Using Ollama provider: ${ollama.name}`, {
          host: config.ollamaHost,
          dimensions: ollama.dimensions,
        });
        return { provider: ollama, rejected, explicitError: null };
      }
    } else if (requested === 'ollama') {
      return {
        provider: null,
        rejected,
        explicitError:
          `Ollama provider requested but "${model}" not available at ${config.ollamaHost}. ` +
          `Install with: ollama pull ${model}`,
      };
    } else {
      logger.debug('embeddings', 'Ollama not available, trying OpenAI');
    }
  }

  // 2. Try OpenAI (if auto or explicitly requested). In the auto-cascade an
  // explicitly-set NEUROMCP_EMBEDDING_MODEL is almost certainly an Ollama
  // model name (e.g. nomic-embed-text) — passing it through would create an
  // OpenAI provider for a model that does not exist, with guessed
  // dimensions. Only honor the explicit model here when it looks like an
  // OpenAI embedding model or when OpenAI was explicitly requested.
  if (requested === 'auto' || requested === 'openai') {
    const model =
      config.embeddingModel === 'auto' ||
      (requested === 'auto' && !config.embeddingModel.startsWith('text-embedding'))
        ? 'text-embedding-3-small'
        : config.embeddingModel;
    const openai = new OpenAIEmbeddingProvider(model, undefined, config.embeddingUrl ?? undefined, {
      timeoutMs: config.embedTimeoutMs,
    });
    if (await openai.isAvailable()) {
      if (accept(openai)) {
        logger.info('embeddings', `Using OpenAI provider: ${openai.name}`, {
          dimensions: openai.dimensions,
        });
        return { provider: openai, rejected, explicitError: null };
      }
    } else if (requested === 'openai') {
      return {
        provider: null,
        rejected,
        explicitError: 'OpenAI provider requested but OPENAI_API_KEY not set or API unreachable.',
      };
    } else {
      logger.debug('embeddings', 'OpenAI not available, falling back to ONNX');
    }
  }

  // 3. Try ONNX (if auto or explicitly requested) — degraded quality.
  // Ruled out statically first: probing can trigger the lazy ~33 MB model
  // download, which must never run for a provider that cannot match anyway.
  if (requested === 'auto' || requested === 'onnx') {
    const staticSkip = staticOnnxSkipReason(options);
    if (staticSkip !== null) {
      rejected.push(staticSkip);
      logger.warn('embeddings', 'ONNX ruled out statically — probe and model download skipped', {
        reason: staticSkip,
      });
      return { provider: null, rejected, explicitError: null };
    }
    const onnx = new OnnxEmbeddingProvider();
    if (await onnx.isAvailable()) {
      if (accept(onnx)) {
        logger.info('embeddings', `Using ONNX provider: ${onnx.name}`, {
          dimensions: onnx.dimensions,
        });
        logger.warn('embeddings', 'ONNX uses simplified tokenization — for best quality, install Ollama with nomic-embed-text');
        return { provider: onnx, rejected, explicitError: null };
      }
    } else if (requested === 'onnx') {
      return {
        provider: null,
        rejected,
        explicitError:
          'ONNX provider requested but model not found. Run: npx neuromcp-download-model',
      };
    }
  }

  return { provider: null, rejected, explicitError: null };
}

/**
 * Strict entrypoint: returns a provider or throws. Behaviour (and error
 * text) is unchanged from 0.29.2 for every caller that does not care about
 * the existing index width — bin/embed.mjs, bin/query.mjs, the backfill
 * script, and the fresh-database path in runtime.ts.
 */
export async function createEmbeddingProvider(
  config: NeuromcpConfig,
  logger: Logger,
): Promise<EmbeddingProvider> {
  const { provider, explicitError } = await selectEmbeddingProvider(config, logger);
  if (provider !== null) return provider;
  if (explicitError !== null) throw new Error(explicitError);
  throw new Error(
    `No embedding provider available (requested: ${config.embeddingProvider}). ` +
    'Install Ollama with nomic-embed-text (recommended), set OPENAI_API_KEY for OpenAI, ' +
    'or run: npx neuromcp-download-model for the ONNX fallback.',
  );
}
