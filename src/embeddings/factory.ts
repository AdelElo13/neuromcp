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
  const requireDimension = options.requireDimension;
  const rejected: string[] = [];

  /** Accept a reachable provider only when its width matches the index. */
  const accept = (provider: EmbeddingProvider): boolean => {
    if (requireDimension === undefined || provider.dimensions === requireDimension) return true;
    rejected.push(
      `${provider.name} (${provider.dimensions}d, reachable but the existing index is ${requireDimension}d)`,
    );
    logger.warn('embeddings', 'Provider skipped — dimension does not match the existing vector index', {
      provider: provider.name,
      providerDimensions: provider.dimensions,
      indexDimensions: requireDimension,
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

  // 3. Try ONNX (if auto or explicitly requested) — degraded quality
  if (requested === 'auto' || requested === 'onnx') {
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
