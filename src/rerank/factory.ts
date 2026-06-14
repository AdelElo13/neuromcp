import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { RerankProvider } from './types.js';
import { OnnxCrossEncoderReranker } from './onnx-reranker.js';

/**
 * Build the relevance reranker from config, mirroring
 * createEmbeddingProvider's cascade — with one deliberate difference: the
 * reranker is OPTIONAL. On 'none' (default) or when the model is unavailable
 * under 'auto', we return null so search degrades to plain RRF order. Only an
 * explicit 'onnx' request with a missing model throws (loud misconfiguration).
 */
export async function createRerankProvider(
  config: NeuromcpConfig,
  logger: Logger,
): Promise<RerankProvider | null> {
  const requested = config.reranker;
  if (requested === 'none') return null;

  if (requested === 'auto' || requested === 'onnx') {
    const reranker = new OnnxCrossEncoderReranker();
    if (await reranker.isAvailable()) {
      logger.info('rerank', `Using cross-encoder reranker: ${reranker.name}`, {
        rerankPool: config.rerankPool,
      });
      return reranker;
    }
    if (requested === 'onnx') {
      throw new Error(
        'NEUROMCP_RERANKER=onnx but the reranker model is not present. ' +
          'Run: node scripts/download-reranker.mjs',
      );
    }
    logger.debug('rerank', 'reranker model not present; proceeding without reranking');
  }

  return null;
}
