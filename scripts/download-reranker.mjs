#!/usr/bin/env node
/**
 * download-reranker.mjs — fetch the local cross-encoder reranker assets used
 * by NEUROMCP_RERANKER=onnx (or auto):
 *   - models/ms-marco-MiniLM-L-6-v2.onnx        (quantized ONNX, ~23 MB)
 *   - models/ms-marco-MiniLM-L-6-v2.vocab.txt   (BERT WordPiece vocab)
 *
 * Source: Xenova/ms-marco-MiniLM-L-6-v2 on the Hugging Face hub (Apache-2.0).
 * 0 cloud API at runtime — this is a one-time download; reranking then runs
 * fully locally via onnxruntime-node.
 *
 * Usage: node scripts/download-reranker.mjs
 */
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(__dirname, '..', 'models');

const ASSETS = [
  {
    url: 'https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model_quantized.onnx',
    dest: resolve(MODELS_DIR, 'ms-marco-MiniLM-L-6-v2.onnx'),
    minBytes: 1_000_000,
  },
  {
    url: 'https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/vocab.txt',
    dest: resolve(MODELS_DIR, 'ms-marco-MiniLM-L-6-v2.vocab.txt'),
    minBytes: 100_000,
  },
];

async function downloadOne({ url, dest, minBytes }) {
  if (existsSync(dest) && statSync(dest).size >= minBytes) {
    process.stdout.write(`  ✓ already present: ${dest}\n`);
    return;
  }
  process.stdout.write(`  ↓ ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  // Stream to a .part file, then validate size before renaming — never leave
  // a truncated asset that would wedge the runtime loader.
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const size = statSync(tmp).size;
  if (size < minBytes) {
    throw new Error(`downloaded ${url} is too small (${size} bytes) — aborting`);
  }
  const { renameSync } = await import('node:fs');
  renameSync(tmp, dest);
  process.stdout.write(`  ✓ wrote ${dest} (${(size / 1e6).toFixed(1)} MB)\n`);
}

async function main() {
  mkdirSync(MODELS_DIR, { recursive: true });
  process.stdout.write('Downloading neuromcp cross-encoder reranker assets…\n');
  for (const asset of ASSETS) {
    await downloadOne(asset);
  }
  process.stdout.write('\nDone. Enable with: NEUROMCP_RERANKER=onnx (or auto)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
