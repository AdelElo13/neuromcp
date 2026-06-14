import { describe, it, expect } from 'vitest';
import { basicTokenize, wordpieceTokenize, encodePair } from '../../src/rerank/wordpiece.js';

// Tiny BERT-style vocab. Index == id, mirroring vocab.txt line numbers.
const VOCAB_LINES = [
  '[PAD]', // 0
  '[UNK]', // 1
  '[CLS]', // 2
  '[SEP]', // 3
  'alpha', // 4
  'beta', // 5
  'wid', // 6
  '##get', // 7
  '##gets', // 8
  'the', // 9
  '!', // 10
  'cafe', // 11
];
const vocab = new Map<string, number>(VOCAB_LINES.map((t, i) => [t, i]));

describe('wordpiece tokenizer', () => {
  it('basicTokenize lowercases, strips accents, and splits punctuation', () => {
    expect(basicTokenize('Alpha, the BETA!')).toEqual(['alpha', ',', 'the', 'beta', '!']);
    // accent stripping: café → cafe
    expect(basicTokenize('Café')).toEqual(['cafe']);
  });

  it('wordpieceTokenize does greedy longest-match with ## continuation', () => {
    expect(wordpieceTokenize('widget', vocab)).toEqual(['wid', '##get']);
    expect(wordpieceTokenize('widgets', vocab)).toEqual(['wid', '##gets']);
    expect(wordpieceTokenize('alpha', vocab)).toEqual(['alpha']);
  });

  it('returns [UNK] for an unmatchable word', () => {
    expect(wordpieceTokenize('zzzzz', vocab)).toEqual(['[UNK]']);
  });

  it('encodePair builds [CLS] q [SEP] d [SEP] with correct token_type_ids', () => {
    const enc = encodePair('alpha', 'the widget', vocab, 16);
    // ids: CLS(2) alpha(4) SEP(3) the(9) wid(6) ##get(7) SEP(3)
    const ids = Array.from(enc.inputIds.slice(0, enc.length)).map(Number);
    expect(ids).toEqual([2, 4, 3, 9, 6, 7, 3]);
    const types = Array.from(enc.tokenTypeIds.slice(0, enc.length)).map(Number);
    // query segment (CLS, alpha, first SEP) = 0; doc segment = 1
    expect(types).toEqual([0, 0, 0, 1, 1, 1, 1]);
    const mask = Array.from(enc.attentionMask.slice(0, enc.length)).map(Number);
    expect(mask.every((m) => m === 1)).toBe(true);
    // padding region is zeroed
    expect(Number(enc.inputIds[enc.length])).toBe(0);
    expect(Number(enc.attentionMask[enc.length])).toBe(0);
  });

  it('truncates the document first, preserving the query, within maxLen', () => {
    // maxLen 6 → budget 3 special-excluded slots. query 'alpha beta' = 2 tokens,
    // leaving 1 slot for the doc.
    const enc = encodePair('alpha beta', 'the widget widget', vocab, 6);
    const ids = Array.from(enc.inputIds.slice(0, enc.length)).map(Number);
    // CLS alpha beta SEP the SEP  (doc truncated to just 'the')
    expect(ids).toEqual([2, 4, 5, 3, 9, 3]);
    expect(enc.length).toBe(6);
  });
});
