#!/usr/bin/env node
/**
 * ab-sweep.mjs — real A/B sweep over attribution + attention hyperparams.
 *
 * Reads the last 7 days of labelled retrieval_events. For each event,
 * re-scores the retrieved candidates under each configuration variant
 * using the recorded hybrid-score components (approximated from stored
 * data) and computes the rank of the cited memory. The variant with the
 * lowest mean cited-rank wins.
 *
 * This is NOT a full retrieval re-run — that would require regenerating
 * embeddings under each variant. Instead it tests how the usefulness
 * prior variants would have reshuffled results that already exist. Good
 * enough to answer "does a stronger exploration term hurt the top-K
 * cited rank?" on observed traffic.
 *
 * Writes a report + the winning variant to
 * ~/.neuromcp/experiments/<timestamp>-sweep.md.
 *
 * Usage:
 *   node scripts/ab-sweep.mjs            # full sweep
 *   node scripts/ab-sweep.mjs --dry-run  # print only
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');
const EXP_DIR = join(HOME, '.neuromcp', 'experiments');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const VARIANTS = [
  { name: 'baseline', weightSlope: 0.5, explore: false },
  { name: 'narrow',   weightSlope: 0.3, explore: false },
  { name: 'wide',     weightSlope: 0.7, explore: false },
  { name: 'thompson', weightSlope: 0.5, explore: true },
];

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}
if (!dryRun) mkdirSync(EXP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
const events = db
  .prepare(
    `SELECT id, retrieved_ids, cited_ids, outcome
       FROM retrieval_events
       WHERE created_at >= ? AND outcome IS NOT NULL`,
  )
  .all(since);

if (events.length < 5) {
  console.log(`Only ${events.length} labelled events in the last 7 days — need at least 5 for a meaningful sweep.`);
  console.log('Run more sessions with the critic hook enabled and try again.');
  db.close();
  process.exit(0);
}

function sampleBeta(a, b) {
  // Cheap Beta sample via two gamma draws.
  const g = (shape) => {
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        let u = Math.random(); while (u === 0) u = Math.random();
        let w = Math.random(); while (w === 0) w = Math.random();
        x = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const x = g(Math.max(1, a));
  const y = g(Math.max(1, b));
  return x / (x + y);
}

function rerank(retrievedIds, variant, usefulnessLookup) {
  // Under each variant, compute a factor per id and sort.
  return retrievedIds
    .map((id, originalRank) => {
      const u = usefulnessLookup.get(id) ?? { helpful: 0, harmful: 0, score: 0.5 };
      const score = variant.explore
        ? sampleBeta(u.helpful + 1, u.harmful + 1)
        : u.score;
      const factor = 0.5 + score * (variant.weightSlope * 2); // slope=0.5 → factor∈[0.5,1.5]
      // Approximate base rank score as 1/(rank+60) (RRF). Original rank is
      // the array index, so earlier positions dominate — that's good.
      const base = 1 / (originalRank + 60);
      return { id, score: base * factor };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);
}

const memoryIds = new Set();
for (const ev of events) {
  JSON.parse(ev.retrieved_ids).forEach((id) => memoryIds.add(id));
}

const placeholders = Array.from(memoryIds).map(() => '?').join(',');
const usefulnessRows = memoryIds.size > 0
  ? db.prepare(
      `SELECT memory_id, helpful_count, harmful_count, usefulness_score
         FROM memory_usefulness WHERE memory_id IN (${placeholders})`,
    ).all(...memoryIds)
  : [];
const usefulnessLookup = new Map(
  usefulnessRows.map((r) => [r.memory_id, {
    helpful: r.helpful_count,
    harmful: r.harmful_count,
    score: r.usefulness_score,
  }]),
);

const results = VARIANTS.map((variant) => {
  const citedRanks = [];
  for (const ev of events) {
    const retrieved = JSON.parse(ev.retrieved_ids);
    const cited = new Set(JSON.parse(ev.cited_ids));
    if (cited.size === 0) continue;
    const reranked = rerank(retrieved, variant, usefulnessLookup);
    // Best rank of any cited memory
    let bestRank = Number.POSITIVE_INFINITY;
    for (const id of cited) {
      const r = reranked.indexOf(id);
      if (r >= 0 && r < bestRank) bestRank = r;
    }
    if (Number.isFinite(bestRank)) citedRanks.push(bestRank);
  }
  const mean = citedRanks.length > 0
    ? citedRanks.reduce((a, b) => a + b, 0) / citedRanks.length
    : null;
  return { variant: variant.name, params: variant, n: citedRanks.length, meanCitedRank: mean };
});

results.sort((a, b) => (a.meanCitedRank ?? 999) - (b.meanCitedRank ?? 999));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(EXP_DIR, `${stamp}-sweep.md`);
const lines = [
  `# neuromcp A/B sweep — ${new Date().toISOString()}`,
  '',
  `Events evaluated: ${events.length} (labelled in last 7 days)`,
  `Memory pool: ${memoryIds.size} unique ids`,
  '',
  '## Variants tested',
  '',
  '| Variant | weightSlope | explore | n | mean cited rank | verdict |',
  '|---------|-------------|---------|---|-----------------|---------|',
  ...results.map((r, i) => {
    const verdict = i === 0 ? 'WINNER (lowest rank wins)' : '';
    const mean = r.meanCitedRank === null ? 'n/a' : r.meanCitedRank.toFixed(2);
    return `| ${r.variant} | ${r.params.weightSlope} | ${r.params.explore} | ${r.n} | ${mean} | ${verdict} |`;
  }),
  '',
  '## Interpretation',
  '',
  'Lower mean-cited-rank is better — it means the cited (helpful) memory',
  'ended up higher in the ranked list after the variant\'s re-scoring.',
  '',
  'This is a retrospective sweep over already-logged events; it does not',
  'test hypothetical queries the system never saw. Treat as directional.',
  '',
  '## Recommended action',
  '',
];

const winner = results[0];
if (winner.meanCitedRank === null) {
  lines.push('No variant produced a measurable result. Accumulate more labelled events.');
} else if (winner.variant === 'baseline') {
  lines.push('Baseline wins — current config is tuned correctly for observed traffic.');
} else {
  lines.push(`The "${winner.variant}" variant (weightSlope=${winner.params.weightSlope}, explore=${winner.params.explore}) wins by ${((results[1].meanCitedRank - winner.meanCitedRank) || 0).toFixed(2)} rank positions.`);
  lines.push('Consider shipping this as a config default in a follow-up release.');
}

if (dryRun) {
  console.log(lines.join('\n'));
} else {
  writeFileSync(reportPath, lines.join('\n') + '\n');
  console.log(`Report: ${reportPath}`);
  console.log(`Winner: ${winner.variant} (mean cited rank: ${winner.meanCitedRank?.toFixed(2) ?? 'n/a'})`);
}
db.close();
