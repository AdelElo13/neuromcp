/**
 * A relevance reranker scores (query, document) pairs directly, unlike the
 * bi-encoder embeddings used for first-stage retrieval. It runs as a second
 * stage over the fused RRF candidate pool to sharpen top-k precision.
 *
 * Mirrors the EmbeddingProvider shape (name + isAvailable + the work method)
 * so the factory cascade in factory.ts reads like createEmbeddingProvider.
 */
export interface RerankProvider {
  readonly name: string;
  /** Max query+document token budget per pair. */
  readonly maxTokens: number;
  /** True when the model is loadable (file present, runtime importable). */
  isAvailable(): Promise<boolean>;
  /**
   * Score each document against the query. Returns one score per input
   * document, in the SAME order. Higher = more relevant. Absolute scale is
   * model-specific; only the relative ordering is contractual.
   */
  rerank(query: string, documents: readonly string[]): Promise<number[]>;
}
