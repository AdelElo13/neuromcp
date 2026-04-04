import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL_URL =
  'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';

const MODEL_DIR = resolve(process.cwd(), 'models');
const MODEL_PATH = resolve(MODEL_DIR, 'bge-small-en-v1.5.onnx');

async function main(): Promise<void> {
  if (existsSync(MODEL_PATH)) {
    process.stderr.write(`Model already exists at ${MODEL_PATH}, skipping download.\n`);
    return;
  }

  mkdirSync(MODEL_DIR, { recursive: true });
  process.stderr.write(`Downloading bge-small-en-v1.5 quantized ONNX model...\n`);
  process.stderr.write(`  URL: ${MODEL_URL}\n`);
  process.stderr.write(`  Destination: ${MODEL_PATH}\n`);

  try {
    const response = await fetch(MODEL_URL);

    if (!response.ok) {
      process.stderr.write(`Download failed: HTTP ${response.status} ${response.statusText}\n`);
      return;
    }

    if (response.body === null) {
      process.stderr.write('Download failed: empty response body\n');
      return;
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const sizeMb = (Number(contentLength) / (1024 * 1024)).toFixed(1);
      process.stderr.write(`  Size: ${sizeMb} MB\n`);
    }

    const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const fileStream = createWriteStream(MODEL_PATH);
    await pipeline(nodeStream, fileStream);

    process.stderr.write('Download complete.\n');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Download failed: ${message}\n`);
    process.stderr.write('You can manually download the model from:\n');
    process.stderr.write(`  ${MODEL_URL}\n`);
    process.stderr.write(`And place it at: ${MODEL_PATH}\n`);
    // Do NOT exit(1) — this may run as postinstall and should not block npm install
  }
}

main();
