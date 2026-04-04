import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider } from './types.js';
import type { InferenceSession } from 'onnxruntime-node';

// onnxruntime-node is a peer/optional dependency — lazy import to allow graceful failure
let ort: { InferenceSession: typeof import('onnxruntime-node').InferenceSession; Tensor: typeof import('onnxruntime-node').Tensor } | null = null;

async function loadOrt(): Promise<NonNullable<typeof ort>> {
  if (ort !== null) return ort;
  const mod = await import('onnxruntime-node');
  ort = { InferenceSession: mod.InferenceSession, Tensor: mod.Tensor };
  return ort;
}

const MODEL_FILENAME = 'bge-small-en-v1.5.onnx';

function resolveModelPath(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // From dist/ (bundled) → ../models/ (package root)
    resolve(thisDir, '..', 'models', MODEL_FILENAME),
    // From src/embeddings/ (dev) → ../../models/
    resolve(thisDir, '..', '..', 'models', MODEL_FILENAME),
    // Relative to cwd
    resolve(process.cwd(), 'models', MODEL_FILENAME),
    // Common install location: node_modules/neuromcp/models/
    resolve(thisDir, 'models', MODEL_FILENAME),
  ];

  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Simple hash-based tokenizer for MVP.
 * Maps whitespace-split tokens to pseudo vocabulary IDs via a deterministic hash.
 * This produces consistent but not linguistically accurate token IDs.
 * The eval harness (Task 10) will measure quality; upgrade to WordPiece later.
 */
function simpleTokenize(
  text: string,
  maxLength: number,
): { inputIds: BigInt64Array; attentionMask: BigInt64Array; tokenTypeIds: BigInt64Array } {
  const VOCAB_SIZE = 30522; // bge-small vocab size
  const CLS_ID = 101n;
  const SEP_ID = 102n;
  const PAD_ID = 0n;

  const words = text.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);

  // Hash each word to a pseudo-ID in [1, VOCAB_SIZE)
  const wordIds: bigint[] = words.slice(0, maxLength - 2).map(word => {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    // Map to positive range within vocab
    const id = ((hash % (VOCAB_SIZE - 2)) + (VOCAB_SIZE - 2)) % (VOCAB_SIZE - 2) + 1;
    return BigInt(id);
  });

  const tokenCount = wordIds.length + 2; // +2 for CLS and SEP
  const inputIds = new BigInt64Array(maxLength);
  const attentionMask = new BigInt64Array(maxLength);
  const tokenTypeIds = new BigInt64Array(maxLength);

  // [CLS] ...tokens... [SEP] [PAD]...
  inputIds[0] = CLS_ID;
  attentionMask[0] = 1n;
  for (let i = 0; i < wordIds.length; i++) {
    inputIds[i + 1] = wordIds[i];
    attentionMask[i + 1] = 1n;
  }
  inputIds[wordIds.length + 1] = SEP_ID;
  attentionMask[wordIds.length + 1] = 1n;

  // Remaining positions are already 0 (PAD)
  for (let i = tokenCount; i < maxLength; i++) {
    inputIds[i] = PAD_ID;
    attentionMask[i] = 0n;
    tokenTypeIds[i] = 0n;
  }

  return { inputIds, attentionMask, tokenTypeIds };
}

/**
 * Mean-pool token embeddings, respecting the attention mask.
 */
function meanPool(lastHiddenState: Float32Array, attentionMask: BigInt64Array, seqLen: number, hiddenSize: number): Float32Array {
  const result = new Float32Array(hiddenSize);
  let tokenCount = 0;

  for (let t = 0; t < seqLen; t++) {
    if (attentionMask[t] === 0n) continue;
    tokenCount++;
    const offset = t * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) {
      result[h] += lastHiddenState[offset + h];
    }
  }

  if (tokenCount > 0) {
    for (let h = 0; h < hiddenSize; h++) {
      result[h] /= tokenCount;
    }
  }

  return result;
}

/**
 * L2-normalize a vector in place, returning it.
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'bge-small-en-v1.5';
  readonly dimensions = 384;
  readonly maxTokens = 512;

  private session: InferenceSession | null = null;
  private readonly modelPath: string | null;

  constructor(modelPath?: string) {
    this.modelPath = modelPath ?? resolveModelPath();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureSession();
      return true;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const session = await this.ensureSession();
    const { inputIds, attentionMask, tokenTypeIds } = simpleTokenize(text, this.maxTokens);

    const { Tensor } = await loadOrt();
    const feeds = {
      input_ids: new Tensor('int64', inputIds, [1, this.maxTokens]),
      attention_mask: new Tensor('int64', attentionMask, [1, this.maxTokens]),
      token_type_ids: new Tensor('int64', tokenTypeIds, [1, this.maxTokens]),
    };

    const output = await session.run(feeds);

    // The model output key is typically 'last_hidden_state' or the first output
    const outputTensor = output['last_hidden_state'] ?? Object.values(output)[0];
    if (outputTensor === undefined) {
      throw new Error('ONNX model returned no output tensors');
    }

    const hiddenState = outputTensor.data as Float32Array;
    const pooled = meanPool(hiddenState, attentionMask, this.maxTokens, this.dimensions);
    return l2Normalize(pooled);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  private async ensureSession(): Promise<InferenceSession> {
    if (this.session !== null) return this.session;

    if (this.modelPath === null) {
      throw new Error(
        `ONNX model not found. Run: npx tsx scripts/download-model.ts\n` +
        `Expected location: models/${MODEL_FILENAME}`,
      );
    }

    const { InferenceSession: IS } = await loadOrt();
    this.session = await IS.create(this.modelPath, {
      executionProviders: ['cpu'],
    });
    return this.session;
  }
}
