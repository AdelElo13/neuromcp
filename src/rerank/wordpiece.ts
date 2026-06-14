/**
 * wordpiece.ts — a minimal, dependency-free BERT WordPiece tokenizer for the
 * uncased cross-encoder reranker (cross-encoder/ms-marco-MiniLM-L-6-v2).
 *
 * The repo's ONNX *embedding* provider uses a hash-based pseudo-tokenizer
 * (good enough for a degraded fallback), but a cross-encoder produces a
 * single relevance logit from the full [CLS] query [SEP] doc [SEP] sequence —
 * garbage tokenization yields garbage scores. So we implement real WordPiece
 * from the model's vocab.txt: basic tokenization (lowercase, strip accents,
 * split punctuation) then greedy longest-match-first subword splitting.
 *
 * No new npm dependency — this is ~100 lines of standard BERT preprocessing.
 */
import { readFileSync } from 'node:fs';

const UNK = '[UNK]';

export interface EncodedPair {
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
  readonly tokenTypeIds: BigInt64Array;
  /** Number of non-pad tokens. */
  readonly length: number;
}

/** Load a BERT vocab.txt (one token per line; line number == id). */
export function loadVocab(path: string): Map<string, number> {
  const text = readFileSync(path, 'utf8');
  const vocab = new Map<string, number>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i]!.replace(/\r$/, '');
    // The final newline produces a trailing empty entry; skip empties unless
    // they are a real (rare) blank-token line earlier in the file.
    if (tok.length === 0 && i === lines.length - 1) continue;
    if (!vocab.has(tok)) vocab.set(tok, i);
  }
  return vocab;
}

/** A character is a "word" character if it is a Unicode letter or number. */
function isWordChar(ch: string): boolean {
  return /\p{L}|\p{N}/u.test(ch);
}

/**
 * Basic tokenizer: lowercase, strip accents (NFD + remove combining marks),
 * split on whitespace, then peel punctuation into its own tokens.
 */
export function basicTokenize(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const out: string[] = [];
  for (const word of cleaned.split(/\s+/)) {
    if (word.length === 0) continue;
    let cur = '';
    for (const ch of word) {
      if (isWordChar(ch)) {
        cur += ch;
      } else {
        if (cur.length > 0) {
          out.push(cur);
          cur = '';
        }
        out.push(ch); // punctuation as its own token
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}

/** Greedy longest-match-first WordPiece over a single basic token. */
export function wordpieceTokenize(
  token: string,
  vocab: Map<string, number>,
  maxCharsPerWord = 100,
): string[] {
  if (token.length > maxCharsPerWord) return [UNK];
  const subTokens: string[] = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let cur: string | null = null;
    while (start < end) {
      const piece = start > 0 ? '##' + token.slice(start, end) : token.slice(start, end);
      if (vocab.has(piece)) {
        cur = piece;
        break;
      }
      end--;
    }
    if (cur === null) return [UNK]; // any unmatchable subword → whole token is UNK
    subTokens.push(cur);
    start = end;
  }
  return subTokens;
}

/** Full tokenization of a string into WordPiece tokens. */
function tokenize(text: string, vocab: Map<string, number>): string[] {
  const out: string[] = [];
  for (const basic of basicTokenize(text)) {
    for (const sub of wordpieceTokenize(basic, vocab)) out.push(sub);
  }
  return out;
}

/**
 * Encode a (query, document) pair as the cross-encoder input:
 *   [CLS] query-tokens [SEP] doc-tokens [SEP]
 * with token_type_ids 0 for the query segment (incl. [CLS] and the first
 * [SEP]) and 1 for the document segment (incl. its [SEP]). Padded/truncated
 * to `maxLen`. The document is truncated first to preserve the query.
 */
export function encodePair(
  query: string,
  doc: string,
  vocab: Map<string, number>,
  maxLen: number,
): EncodedPair {
  const id = (tok: string): bigint => BigInt(vocab.get(tok) ?? vocab.get(UNK) ?? 100);
  const CLS = id('[CLS]');
  const SEP = id('[SEP]');

  const queryTokens = tokenize(query, vocab);
  let docTokens = tokenize(doc, vocab);

  // Budget: maxLen - 3 special tokens ([CLS], [SEP], [SEP]).
  const budget = Math.max(0, maxLen - 3);
  const qTrunc = queryTokens.slice(0, Math.min(queryTokens.length, budget));
  const docBudget = Math.max(0, budget - qTrunc.length);
  docTokens = docTokens.slice(0, docBudget);

  const inputIds = new BigInt64Array(maxLen);
  const attentionMask = new BigInt64Array(maxLen);
  const tokenTypeIds = new BigInt64Array(maxLen);

  let pos = 0;
  inputIds[pos] = CLS;
  attentionMask[pos] = 1n;
  tokenTypeIds[pos] = 0n;
  pos++;
  for (const tok of qTrunc) {
    inputIds[pos] = id(tok);
    attentionMask[pos] = 1n;
    tokenTypeIds[pos] = 0n;
    pos++;
  }
  inputIds[pos] = SEP;
  attentionMask[pos] = 1n;
  tokenTypeIds[pos] = 0n;
  pos++;
  for (const tok of docTokens) {
    inputIds[pos] = id(tok);
    attentionMask[pos] = 1n;
    tokenTypeIds[pos] = 1n;
    pos++;
  }
  inputIds[pos] = SEP;
  attentionMask[pos] = 1n;
  tokenTypeIds[pos] = 1n;
  pos++;

  // Remaining positions stay 0 (PAD id 0, mask 0, type 0).
  return { inputIds, attentionMask, tokenTypeIds, length: pos };
}
