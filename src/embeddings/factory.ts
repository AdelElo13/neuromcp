import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { EmbeddingProvider } from './types.js';
import { OnnxEmbeddingProvider } from './onnx.js';

export async function createEmbeddingProvider(
  config: NeuromcpConfig,
  logger: Logger,
): Promise<EmbeddingProvider> {
  const requestedProvider = config.embeddingProvider;

  if (requestedProvider === 'auto' || requestedProvider === 'onnx') {
    const provider = new OnnxEmbeddingProvider();
    const available = await provider.isAvailable();

    if (available) {
      logger.info('embeddings', `Loaded ONNX provider: ${provider.name}`, {
        dimensions: provider.dimensions,
      });
      return provider;
    }

    if (requestedProvider === 'onnx') {
      throw new Error(
        'ONNX embedding provider requested but unavailable. ' +
        'Run: npx tsx scripts/download-model.ts',
      );
    }
  }

  // Phase 1: only ONNX is supported
  throw new Error(
    `No embedding provider available (requested: ${requestedProvider}). ` +
    'Currently only ONNX is supported. Run: npx tsx scripts/download-model.ts',
  );
}
