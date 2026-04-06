import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { EmbeddingProvider } from './types.js';
import { OnnxEmbeddingProvider } from './onnx.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAIEmbeddingProvider } from './openai.js';

export async function createEmbeddingProvider(
  config: NeuromcpConfig,
  logger: Logger,
): Promise<EmbeddingProvider> {
  const requested = config.embeddingProvider;

  // 1. Try Ollama first (if auto or explicitly requested) — real semantic quality
  if (requested === 'auto' || requested === 'ollama') {
    const model = config.embeddingModel === 'auto' ? 'nomic-embed-text' : config.embeddingModel;
    const ollama = new OllamaEmbeddingProvider(config.ollamaHost, model);
    if (await ollama.isAvailable()) {
      logger.info('embeddings', `Using Ollama provider: ${ollama.name}`, {
        host: config.ollamaHost,
        dimensions: ollama.dimensions,
      });
      return ollama;
    }
    if (requested === 'ollama') {
      throw new Error(
        `Ollama provider requested but "${model}" not available at ${config.ollamaHost}. ` +
        `Install with: ollama pull ${model}`,
      );
    }
    logger.debug('embeddings', 'Ollama not available, trying OpenAI');
  }

  // 2. Try OpenAI (if auto or explicitly requested)
  if (requested === 'auto' || requested === 'openai') {
    const model = config.embeddingModel === 'auto' ? 'text-embedding-3-small' : config.embeddingModel;
    const openai = new OpenAIEmbeddingProvider(model, undefined, config.embeddingUrl ?? undefined);
    if (await openai.isAvailable()) {
      logger.info('embeddings', `Using OpenAI provider: ${openai.name}`, {
        dimensions: openai.dimensions,
      });
      return openai;
    }
    if (requested === 'openai') {
      throw new Error(
        'OpenAI provider requested but OPENAI_API_KEY not set or API unreachable.',
      );
    }
    logger.debug('embeddings', 'OpenAI not available, falling back to ONNX');
  }

  // 3. Try ONNX (if auto or explicitly requested) — degraded quality
  if (requested === 'auto' || requested === 'onnx') {
    const onnx = new OnnxEmbeddingProvider();
    if (await onnx.isAvailable()) {
      logger.info('embeddings', `Using ONNX provider: ${onnx.name}`, {
        dimensions: onnx.dimensions,
      });
      logger.warn('embeddings', 'ONNX uses simplified tokenization — for best quality, install Ollama with nomic-embed-text');
      return onnx;
    }
    if (requested === 'onnx') {
      throw new Error(
        'ONNX provider requested but model not found. Run: node scripts/download-model.mjs',
      );
    }
  }

  throw new Error(
    `No embedding provider available (requested: ${requested}). ` +
    'Install Ollama with nomic-embed-text (recommended), set OPENAI_API_KEY for OpenAI, ' +
    'or run: node scripts/download-model.mjs for ONNX fallback.',
  );
}
