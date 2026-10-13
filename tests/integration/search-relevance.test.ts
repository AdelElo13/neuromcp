import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, DIMS, type TestContext } from '../helpers/index.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import type { Logger } from '../../src/observability/logger.js';
import {
  searchMemory,
  searchMemoryDetailed,
  keywordCoverage,
  ftsQueryTokens,
  defaultMinSimilarity,
  type SearchDeps,
} from '../../src/tools/search.js';
import { loadConfig } from '../../src/config.js';

describe('keyword coverage matches FTS5 unicode61 tokenization', () => {
  it('folds diacritics and Unicode normalization forms like FTS5 does', () => {
    expect(keywordCoverage(ftsQueryTokens('cafe'), 'Gesprek in het café over de printer')).toBe(1);
    expect(keywordCoverage(ftsQueryTokens('café'), 'gesprek in het cafe')).toBe(1);
    const nfd = 'gesprek in het café';
    expect(keywordCoverage(ftsQueryTokens('café'), nfd)).toBe(1);
  });

  it('treats "_" as a separator like FTS5 unicode61', () => {
    expect(keywordCoverage(ftsQueryTokens('filament index'), 'filament_self_index moet 3 zijn')).toBe(1);
    expect(keywordCoverage(ftsQueryTokens('filament_self_index'), 'filament self index')).toBe(1);
  });
});

describe('relevance floor configuration', () => {
  it('an empty or invalid NEUROMCP_MIN_SIMILARITY means "use the default", not "off"', () => {
    const saved = process.env['NEUROMCP_MIN_SIMILARITY'];
    try {
      for (const raw of ['', '  ', 'abc']) {
        process.env['NEUROMCP_MIN_SIMILARITY'] = raw;
        expect(loadConfig().minSimilarity, JSON.stringify(raw)).toBeNull();
      }
      process.env['NEUROMCP_MIN_SIMILARITY'] = '0';
      expect(loadConfig().minSimilarity).toBe(0);
    } finally {
      if (saved === undefined) delete process.env['NEUROMCP_MIN_SIMILARITY'];
      else process.env['NEUROMCP_MIN_SIMILARITY'] = saved;
    }
  });

  it('the calibrated default ignores an Ollama tag suffix', () => {
    expect(defaultMinSimilarity('bge-m3')).toBe(0.45);
    expect(defaultMinSimilarity('bge-m3:latest')).toBe(0.45);
    expect(defaultMinSimilarity('nomic-embed-text')).toBe(0);
  });
});
import { explainMemory } from '../../src/cognitive/explain.js';
import type { Memory } from '../../src/types.js';

/**
 * search_memory relevance regressions (field report, neuromcp 0.29.4/0.29.5):
 *  - a low-importance memory that is the unique lexical + vector match ranked
 *    LAST behind unrelated importance-0.8 memories;
 *  - multi-word queries only matched as an exact adjacent phrase in FTS;
 *  - RRF threw away the cosine gap, the 0.7–1.0 importance multiplier
 *    dominated relevance;
 *  - no relevance floor; every returned row got access_count+1
 *    (rich-get-richer);
 *  - failing scoring stages logged no error and the caller saw nothing;
 *  - explain.claims carried all-null rows.
 */

/** Deterministic bag-of-words embedder: cosine ≈ word overlap. */
class BagOfWordsEmbedder implements EmbeddingProvider {
  readonly name = 'bow';
  readonly dimensions = DIMS;
  readonly maxTokens = 512;

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMS);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
      v[(h >>> 0) % DIMS]! += 1;
    }
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < DIMS; i++) v[i]! /= norm;
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Every text embeds to the same vector: the vector leg carries no signal. */
class ConstantEmbedder extends BagOfWordsEmbedder {
  override async embed(): Promise<Float32Array> {
    return super.embed('constant');
  }
}

interface CapturedLog {
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

function capturingLogger(sink: CapturedLog[]): Logger {
  const push = (_c: string, message: string, metadata?: Record<string, unknown>): void => {
    sink.push({ message, metadata });
  };
  return { debug: () => {}, info: () => {}, warn: push, error: push };
}

const UNRELATED = [
  'GitHub account is AdelElo13, authenticated through the gh CLI',
  '3D workstation status: Bambu H2C and Snapmaker U1 both online',
  'Design proposal v0.1 for the memory browser landing page',
  'Weekly review happens on sunday evening with a short checklist',
];

const TARGET = 'Testgeheugen: de groene filamentrol staat op de bovenste plank naast de P1S';

describe('searchMemory relevance', () => {
  let ctx: TestContext;
  let logs: CapturedLog[];

  beforeEach(() => {
    ctx = setupTestDb();
    logs = [];
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  function deps(embedder: EmbeddingProvider, configOverrides: Record<string, unknown> = {}): SearchDeps {
    return {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder,
      logger: capturingLogger(logs),
      metrics: ctx.metrics,
      config: { ...ctx.config, ...configOverrides },
    };
  }

  async function seed(
    embedder: EmbeddingProvider,
    rows: ReadonlyArray<{ content: string; importance: number; access_count?: number }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const row of rows) {
      const id = insertTestMemory(ctx, {
        content: row.content,
        importance: row.importance,
        access_count: row.access_count ?? 0,
        last_accessed_at: row.access_count ? new Date().toISOString() : null,
      });
      ctx.db.prepare('UPDATE memories SET effective_importance = ? WHERE id = ?').run(row.importance, id);
      // memories_fts is external-content without triggers; store.ts indexes
      // explicitly, insertTestMemory does not.
      ctx.db.prepare(
        `INSERT INTO memories_fts (rowid, content, summary, tags, category)
         SELECT rowid, content, NULL, tags, category FROM memories WHERE id = ?`,
      ).run(id);
      ctx.vecStore.upsert(id, await embedder.embed(row.content));
      ids.push(id);
    }
    return ids;
  }

  const popular = (content: string) => ({ content, importance: 0.9, access_count: 25 });

  it('matches multi-word queries on non-adjacent words (FTS is not a phrase query)', async () => {
    const embedder = new ConstantEmbedder();
    const [targetId] = await seed(embedder, [{ content: TARGET, importance: 0.1 }, ...UNRELATED.map(popular)]);

    const results = await searchMemory({ query: 'filamentrol plank', limit: 3, explain: false }, deps(embedder));

    expect(results[0]?.id).toBe(targetId);
  });

  it('ranks a low-importance unique lexical+vector match above popular unrelated memories', async () => {
    const embedder = new BagOfWordsEmbedder();
    const [targetId] = await seed(embedder, [{ content: TARGET, importance: 0.1 }, ...UNRELATED.map(popular)]);

    for (const variant of [{}, { hybrid: false }, { graph_boost: false }]) {
      const results = await searchMemory(
        { query: 'groene filamentrol plank', limit: 3, explain: false, ...variant },
        deps(embedder),
      );
      expect(results[0]?.id, JSON.stringify(variant)).toBe(targetId);
    }
  });

  it('hybrid:false orders by vector similarity, importance only breaks ties', async () => {
    const embedder = new BagOfWordsEmbedder();
    const [strong, weak, tieLow, tieHigh] = await seed(embedder, [
      { content: 'rode spoel pla filament voorraad', importance: 0.1 },
      { content: 'rode auto in de garage', importance: 0.95, access_count: 40 },
      { content: 'blauwe spoel', importance: 0.2 },
      { content: 'blauwe spoel', importance: 0.9 },
    ]);

    const byVector = await searchMemory(
      { query: 'rode spoel pla filament', hybrid: false, limit: 4, explain: false },
      deps(embedder),
    );
    expect(byVector[0]?.id).toBe(strong);
    expect(byVector.findIndex((r) => r.id === strong)).toBeLessThan(byVector.findIndex((r) => r.id === weak));

    const tie = await searchMemory({ query: 'blauwe spoel', hybrid: false, limit: 2, explain: false }, deps(embedder));
    expect(tie.map((r) => r.id)).toEqual([tieHigh, tieLow]);
  });

  it('applies a calibrated default floor for known embedders; explicit settings win', async () => {
    // Measured on 2402 real memories: with bge-m3 a 0.45 floor keeps 98% of
    // true targets and empties 73% of off-topic queries. Unknown embedders
    // (and nomic, whose off-topic scores exceed true matches) stay off.
    class NamedBow extends BagOfWordsEmbedder {
      constructor(modelName: string) {
        super();
        // `name` is an instance field on the base class; redefine it.
        Object.defineProperty(this, 'name', { value: modelName });
      }
    }
    const bge = new NamedBow('bge-m3');
    await seed(bge, [{ content: TARGET, importance: 0.5 }, ...UNRELATED.map(popular)]);
    const offTopic = { query: 'kwantumfysica zonnestelsel', limit: 3, explain: false };

    const byDefault = await searchMemoryDetailed(offTopic, deps(bge, { minSimilarity: null }));
    expect(byDefault.results).toEqual([]);
    expect(byDefault.diagnostics.below_threshold_dropped).toBeGreaterThan(0);

    const unknownModel = await searchMemoryDetailed(offTopic, deps(new NamedBow('some-other-model'), { minSimilarity: null }));
    expect(unknownModel.results.length).toBe(3);

    const explicitOff = await searchMemoryDetailed(offTopic, deps(bge, { minSimilarity: 0 }));
    expect(explicitOff.results.length).toBe(3);

    const perCallOff = await searchMemoryDetailed({ ...offTopic, min_similarity: 0 }, deps(bge, { minSimilarity: null }));
    expect(perCallOff.results.length).toBe(3);
  });

  it('min_similarity drops irrelevant candidates and reports how many', async () => {
    const embedder = new BagOfWordsEmbedder();
    await seed(embedder, [{ content: TARGET, importance: 0.5 }, ...UNRELATED.map(popular)]);

    const detailed = await searchMemoryDetailed(
      { query: 'kwantumfysica zonnestelsel', limit: 3, explain: false, min_similarity: 0.3 },
      deps(embedder),
    );
    expect(detailed.results.length).toBeLessThan(3);
    expect(detailed.diagnostics.below_threshold_dropped).toBeGreaterThan(0);

    // An FTS hit survives the floor even when the vector leg is weak.
    const lexical = await searchMemoryDetailed(
      { query: 'filamentrol', limit: 3, explain: false, min_similarity: 0.99 },
      deps(embedder),
    );
    expect(lexical.results.map((r) => r.content)).toEqual([TARGET]);
  });

  it('a stopword-only keyword match neither boosts a row nor exempts it from the floor', async () => {
    const embedder = new BagOfWordsEmbedder();
    await seed(embedder, [
      { content: TARGET, importance: 0.5 },
      { content: 'Het weer in de tuin was goed voor de planten', importance: 0.5 },
      { content: 'De kat zit in de vensterbank', importance: 0.5 },
    ]);

    const detailed = await searchMemoryDetailed(
      { query: 'kwantumfysica in de ruimte', limit: 5, explain: false, min_similarity: 0.6 },
      deps(embedder),
    );

    expect(detailed.results).toEqual([]);
    expect(detailed.diagnostics.below_threshold_dropped).toBe(3);
  });

  it('a keyword hit on one ordinary word of a longer query does not bypass the floor', async () => {
    // Measured on real data: off-topic "beste manier om tomaten te kweken op
    // het balkon" got 23 FTS hits on "beste"/"manier" alone, each exempt from
    // the floor and each with a full RRF keyword bonus. A keyword hit must
    // cover at least half of the query's content words to count as direct
    // relevance; partial coverage only earns a proportional bonus.
    const embedder = new BagOfWordsEmbedder();
    const [partial, full] = await seed(embedder, [
      { content: 'De beste manier van werken met de printer', importance: 0.5 },
      { content: 'Tomaten kweken op het balkon gaat het beste in de zon', importance: 0.5 },
    ]);

    const detailed = await searchMemoryDetailed(
      { query: 'tomaten kweken balkon zomer beste', limit: 5, explain: false, min_similarity: 0.9 },
      deps(embedder),
    );

    const ids = detailed.results.map((r) => r.id);
    expect(ids).toContain(full);
    expect(ids).not.toContain(partial);
  });

  it('a keyword that only appears in tags still counts (FTS indexes tags too)', async () => {
    const embedder = new BagOfWordsEmbedder();
    const id = insertTestMemory(ctx, { content: 'Instelling voor de eerste laag aangepast', tags: ['ironing', 'bambu'] });
    ctx.db.prepare(
      `INSERT INTO memories_fts (rowid, content, summary, tags, category)
       SELECT rowid, content, NULL, tags, category FROM memories WHERE id = ?`,
    ).run(id);
    ctx.vecStore.upsert(id, await embedder.embed('Instelling voor de eerste laag aangepast'));

    const detailed = await searchMemoryDetailed(
      { query: 'ironing', limit: 3, explain: false, min_similarity: 0.99 },
      deps(embedder),
    );
    expect(detailed.results.map((r) => r.id)).toEqual([id]);
  });

  it('a graph-connected candidate is not removed by the relevance floor', async () => {
    const embedder = new BagOfWordsEmbedder();
    const [graphOnly] = await seed(embedder, [{ content: 'Leverancier voor de nieuwe printer gekozen', importance: 0.5 }]);
    const entityId = 'ent-bambu';
    ctx.db.prepare(
      "INSERT INTO entities (id, name, entity_type, namespace) VALUES (?, 'Bambu', 'organization', 'default')",
    ).run(entityId);
    ctx.db.prepare(
      'INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)',
    ).run(graphOnly, entityId);

    const detailed = await searchMemoryDetailed(
      { query: 'Bambu', limit: 5, explain: false, min_similarity: 0.9 },
      deps(embedder),
    );

    expect(detailed.results.map((r) => r.id)).toContain(graphOnly);
  });

  it('repeated searches do not inflate unrelated memories (no rich-get-richer)', async () => {
    const embedder = new BagOfWordsEmbedder();
    const ids = await seed(embedder, [
      { content: TARGET, importance: 0.3 },
      ...UNRELATED.map((content) => ({ content, importance: 0.5 })),
    ]);
    const accessCounts = () =>
      ctx.db.prepare(`SELECT id, access_count FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as Array<{ id: string; access_count: number }>;

    const q2 = { query: 'groene filamentrol plank', limit: 5, explain: false, min_similarity: 0.2 };
    const before = (await searchMemory(q2, deps(embedder))).map((r) => r.id);
    const countsBefore = new Map(accessCounts().map((r) => [r.id, r.access_count]));

    const q1 = { query: 'workstation account review proposal', limit: 5, explain: false };
    const q1Top = (await searchMemory(q1, deps(embedder)))[0]!.id;
    for (let i = 0; i < 9; i++) {
      await searchMemory(q1, deps(embedder));
    }

    // Exactly the top-1 of each search counts as a use; nothing else moves.
    const changed = accessCounts().filter((r) => r.access_count !== countsBefore.get(r.id));
    expect(changed).toEqual([{ id: q1Top, access_count: (countsBefore.get(q1Top) ?? 0) + 10 }]);
    const after = (await searchMemory(q2, deps(embedder))).map((r) => r.id);
    expect(after).toEqual(before);
  });

  it('a failing scoring stage logs the error and is reported as degraded', async () => {
    const embedder = new BagOfWordsEmbedder();
    await seed(embedder, [{ content: TARGET, importance: 0.5 }, ...UNRELATED.map(popular)]);
    ctx.db.prepare('DROP TABLE memories_fts').run();
    ctx.db.prepare('DROP TABLE entities').run();

    const detailed = await searchMemoryDetailed(
      { query: 'Filamentrol Plank', limit: 3, explain: false },
      deps(embedder),
    );

    expect(detailed.diagnostics.degraded).toEqual(expect.arrayContaining(['fts', 'graph']));
    const fts = logs.find((l) => l.message.startsWith('FTS5 query failed'));
    const graph = logs.find((l) => l.message.startsWith('Graph boost failed'));
    expect(String(fts?.metadata?.error)).toMatch(/memories_fts/);
    expect(String(graph?.metadata?.error)).toMatch(/entities/);
    expect(detailed.results.length).toBeGreaterThan(0);
  });

  it('explain.claims omits rows whose subject, predicate and object are all null', async () => {
    const embedder = new BagOfWordsEmbedder();
    const [id] = await seed(embedder, [{ content: TARGET, importance: 0.5 }]);
    const insert = ctx.db.prepare(
      'INSERT INTO claims (id, memory_id, content, subject, predicate, object, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('c-empty', id, 'x', null, null, null, 0.7);
    insert.run('c-real', id, 'filamentrol staat op plank', 'filamentrol', 'staat op', 'plank', 0.8);

    const memory = ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
    const explanation = explainMemory(ctx.db, memory);

    expect(explanation.claims).toHaveLength(1);
    expect(explanation.claims[0]?.subject).toBe('filamentrol');
    expect(explanation.confidence.claim_count).toBe(1);
  });
});
