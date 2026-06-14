/**
 * onnx-reranker.ts — local cross-encoder reranker over onnxruntime-node
 * (already a dependency). Model: cross-encoder/ms-marco-MiniLM-L-6-v2, a
 * tiny (~22M param) BERT-uncased sequence classifier that outputs one
 * relevance logit per (query, document) pair. Real WordPiece tokenization
 * (see wordpiece.ts) — no new npm dependency, 0 cloud API.
 *
 * Download with: node scripts/download-reranker.mjs
 */
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InferenceSession } from 'onnxruntime-node';
import type { RerankProvider } from './types.js';
import { loadVocab, encodePair } from './wordpiece.js';

let ort: {
  InferenceSession: typeof import('onnxruntime-node').InferenceSession;
  Tensor: typeof import('onnxruntime-node').Tensor;
} | null = null;

async function loadOrt(): Promise<NonNullable<typeof ort>> {
  if (ort !== null) return ort;
  const mod = await import('onnxruntime-node');
  ort = { InferenceSession: mod.InferenceSession, Tensor: mod.Tensor };
  return ort;
}

const MODEL_FILENAME = 'ms-marco-MiniLM-L-6-v2.onnx';
const VOCAB_FILENAME = 'ms-marco-MiniLM-L-6-v2.vocab.txt';

function resolveAsset(filename: string): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(thisDir, '..', 'models', filename), // dist/ (bundled) → ../models
    resolve(thisDir, '..', '..', 'models', filename), // src/rerank/ (dev) → ../../models
    resolve(process.cwd(), 'models', filename),
    resolve(thisDir, 'models', filename),
  ];
  for (const c of [...new Set(candidates)]) {
    if (existsSync(c)) return c;
  }
  return null;
}

export class OnnxCrossEncoderReranker implements RerankProvider {
  readonly name = 'ms-marco-MiniLM-L-6-v2';
  readonly maxTokens = 512;

  private session: InferenceSession | null = null;
  private vocab: Map<string, number> | null = null;
  private readonly modelPath: string | null;
  private readonly vocabPath: string | null;

  constructor(modelPath?: string, vocabPath?: string) {
    this.modelPath = modelPath ?? resolveAsset(MODEL_FILENAME);
    this.vocabPath = vocabPath ?? resolveAsset(VOCAB_FILENAME);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureReady();
      return true;
    } catch {
      return false;
    }
  }

  async rerank(query: string, documents: readonly string[]): Promise<number[]> {
    if (documents.length === 0) return [];
    const { session, vocab } = await this.ensureReady();
    const { Tensor } = await loadOrt();

    const n = documents.length;
    const inputIds = new BigInt64Array(n * this.maxTokens);
    const attentionMask = new BigInt64Array(n * this.maxTokens);
    const tokenTypeIds = new BigInt64Array(n * this.maxTokens);

    for (let i = 0; i < n; i++) {
      const enc = encodePair(query, documents[i]!, vocab, this.maxTokens);
      inputIds.set(enc.inputIds, i * this.maxTokens);
      attentionMask.set(enc.attentionMask, i * this.maxTokens);
      tokenTypeIds.set(enc.tokenTypeIds, i * this.maxTokens);
    }

    const dims = [n, this.maxTokens];
    const feeds: Record<string, import('onnxruntime-node').Tensor> = {
      input_ids: new Tensor('int64', inputIds, dims),
      attention_mask: new Tensor('int64', attentionMask, dims),
      token_type_ids: new Tensor('int64', tokenTypeIds, dims),
    };

    const output = await session.run(feeds);
    const logitsTensor = output['logits'] ?? Object.values(output)[0];
    if (logitsTensor === undefined) {
      throw new Error('reranker ONNX model returned no output tensor');
    }
    const data = logitsTensor.data as Float32Array;
    // Output is [n, 1] (single relevance label). data length is n.
    const scores: number[] = [];
    for (let i = 0; i < n; i++) scores.push(data[i] ?? 0);
    return scores;
  }

  private async ensureReady(): Promise<{ session: InferenceSession; vocab: Map<string, number> }> {
    if (this.modelPath === null || this.vocabPath === null) {
      throw new Error(
        `reranker assets not found (model: ${MODEL_FILENAME}, vocab: ${VOCAB_FILENAME}). ` +
          `Run: node scripts/download-reranker.mjs`,
      );
    }
    if (this.vocab === null) {
      this.vocab = loadVocab(this.vocabPath);
    }
    if (this.session === null) {
      const { InferenceSession: IS } = await loadOrt();
      this.session = await IS.create(this.modelPath, { executionProviders: ['cpu'] });
    }
    return { session: this.session, vocab: this.vocab };
  }
}
