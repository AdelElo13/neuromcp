import { describe, it, expect, beforeAll } from 'vitest';
import { OnnxEmbeddingProvider } from '../../src/embeddings/onnx.js';

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe('OnnxEmbeddingProvider', () => {
  let provider: OnnxEmbeddingProvider;
  let available: boolean;

  beforeAll(async () => {
    provider = new OnnxEmbeddingProvider();
    available = await provider.isAvailable();
  });

  it('reports correct name and dimensions', () => {
    expect(provider.name).toBe('bge-small-en-v1.5');
    expect(provider.dimensions).toBe(384);
    expect(provider.maxTokens).toBe(512);
  });

  it('generates embeddings of correct length', async () => {
    if (!available) {
      console.warn('Skipping: ONNX model not available. Run: npx tsx scripts/download-model.ts');
      return;
    }
    const embedding = await provider.embed('hello world');
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(384);
  });

  it('produces L2-normalized embeddings (magnitude ~1.0)', async () => {
    if (!available) {
      console.warn('Skipping: ONNX model not available.');
      return;
    }
    const embedding = await provider.embed('the quick brown fox');
    let sumSq = 0;
    for (let i = 0; i < embedding.length; i++) {
      sumSq += embedding[i] * embedding[i];
    }
    const magnitude = Math.sqrt(sumSq);
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  it('similar texts are more similar than dissimilar texts', async () => {
    if (!available) {
      console.warn('Skipping: ONNX model not available.');
      return;
    }
    const [embA, embB, embC] = await provider.embedBatch([
      'the cat sat on the mat',
      'the kitten rested on the rug',
      'quantum mechanics describes particle behavior',
    ]);

    const simAB = cosineSimilarity(embA, embB);
    const simAC = cosineSimilarity(embA, embC);

    // Cat/kitten sentences should be more similar than cat/quantum
    expect(simAB).toBeGreaterThan(simAC);
  });

  it('embedBatch returns correct number of results', async () => {
    if (!available) {
      console.warn('Skipping: ONNX model not available.');
      return;
    }
    const texts = ['first text', 'second text', 'third text'];
    const results = await provider.embedBatch(texts);
    expect(results).toHaveLength(3);
    for (const emb of results) {
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb.length).toBe(384);
    }
  });
});
