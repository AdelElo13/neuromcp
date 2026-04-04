import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_URL = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';
const MODEL_DIR = resolve(__dirname, '..', 'models');
const MODEL_PATH = resolve(MODEL_DIR, 'bge-small-en-v1.5.onnx');

async function main() {
  if (existsSync(MODEL_PATH)) {
    process.stderr.write('[neuromcp] Model already exists, skipping download.\n');
    return;
  }

  mkdirSync(MODEL_DIR, { recursive: true });
  process.stderr.write('[neuromcp] Downloading bge-small-en-v1.5 ONNX model (~33MB)...\n');

  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    process.stderr.write(`[neuromcp] Download failed: ${response.status}. Run manually: node scripts/download-model.mjs\n`);
    return;
  }

  const nodeStream = Readable.fromWeb(response.body);
  await pipeline(nodeStream, createWriteStream(MODEL_PATH));
  process.stderr.write('[neuromcp] Model downloaded.\n');
}

main().catch(() => {
  process.stderr.write('[neuromcp] Model download failed. Embeddings will not work until model is available.\n');
});
