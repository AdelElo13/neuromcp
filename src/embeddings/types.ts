export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly maxTokens: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  isAvailable(): Promise<boolean>;
}
