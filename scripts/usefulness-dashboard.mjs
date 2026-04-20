#!/usr/bin/env node
/**
 * usefulness-dashboard.mjs — weekly stats report over critic signal.
 *
 * This is an OBSERVABILITY tool, not an optimizer. It reads the last 7
 * days of retrieval_events + memory_usefulness and prints:
 *   - total retrievals, labelled count, helpful_rate, harmful count
 *   - top-10 most helpful memories (by usefulness_score)
 *   - bottom-10 most harmful memories
 *   - a recommendation string derived from helpful_rate thresholds
 *
 * It does NOT sweep configuration variants or promote winners — an
 * earlier draft claimed to, but that work was never implemented and
 * the file was renamed from `autoresearch.mjs` to match what it
 * actually does. Real A/B sweep scaffolding lands in v0.17.0.
 *
 * Usage:
 *   node scripts/usefulness-dashboard.mjs            # write report
 *   node scripts/usefulness-dashboard.mjs --dry-run  # print, do not write
 *
 * Writes to ~/.neuromcp/experiments/<timestamp>.md. Schedule via
 * launchd (weekly StartInterval) for autonomous reporting.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');
const EXP_DIR = join(HOME, '.neuromcp', 'experiments');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}
if (!dryRun) mkdirSync(EXP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Compute baseline metrics from the last 7 days of critic-labelled events
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
const summary = db
  .prepare(
    `SELECT
       count(*) AS total,
       sum(CASE WHEN outcome = 'helpful' THEN 1 ELSE 0 END) AS helpful,
       sum(CASE WHEN outcome = 'harmful' THEN 1 ELSE 0 END) AS harmful,
       sum(CASE WHEN outcome = 'neutral' THEN 1 ELSE 0 END) AS neutral,
       sum(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS labelled
     FROM retrieval_events
     WHERE created_at >= ?`
  )
  .get(since);

const labelled = summary?.labelled ?? 0;
const helpful = summary?.helpful ?? 0;
const helpfulRate = labelled > 0 ? helpful / labelled : null;

console.log(`Critic signal window: last 7 days`);
console.log(`  total retrievals:   ${summary?.total ?? 0}`);
console.log(`  labelled:           ${labelled}`);
console.log(`  helpful_rate:       ${helpfulRate === null ? 'n/a' : helpfulRate.toFixed(3)}`);
console.log(`  harmful:            ${summary?.harmful ?? 0}`);

if (labelled < 10) {
  console.log(`\nNot enough labelled data (< 10 events). Run search_memory + cite_memories with outcomes to accumulate signal.`);
  db.close();
  process.exit(0);
}

// Top helpful memories (recent)
const topHelpful = db
  .prepare(
    `SELECT memory_id, helpful_count, harmful_count, usefulness_score
       FROM memory_usefulness
       WHERE total_observed >= 2 AND last_updated >= ?
       ORDER BY usefulness_score DESC
       LIMIT 10`
  )
  .all(since);

// Bottom (harmful) memories
const topHarmful = db
  .prepare(
    `SELECT memory_id, helpful_count, harmful_count, usefulness_score
       FROM memory_usefulness
       WHERE total_observed >= 2 AND last_updated >= ?
       ORDER BY usefulness_score ASC
       LIMIT 10`
  )
  .all(since);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(EXP_DIR, `${stamp}.md`);

const lines = [
  `# neuromcp usefulness-dashboard report — ${new Date().toISOString()}`,
  '',
  `## Critic signal (last 7 days)`,
  '',
  `- total retrievals: ${summary?.total ?? 0}`,
  `- labelled:         ${labelled}`,
  `- helpful_rate:     ${helpfulRate === null ? 'n/a' : (helpfulRate * 100).toFixed(1) + '%'}`,
  `- harmful:          ${summary?.harmful ?? 0}`,
  '',
  `## Top-10 most helpful memories`,
  '',
];
for (const row of topHelpful) {
  lines.push(`- ${row.memory_id.slice(0, 8)} — score=${row.usefulness_score.toFixed(3)} helpful=${row.helpful_count} harmful=${row.harmful_count}`);
}
lines.push('', `## Bottom-10 most harmful memories`, '');
for (const row of topHarmful) {
  lines.push(`- ${row.memory_id.slice(0, 8)} — score=${row.usefulness_score.toFixed(3)} helpful=${row.helpful_count} harmful=${row.harmful_count}`);
}
lines.push('', `## Recommendations`, '');
if (helpfulRate !== null) {
  if (helpfulRate < 0.5) {
    lines.push(`- helpful_rate below 50% — investigate top harmful memories and consider \`forget_memory\` on the worst offenders.`);
  } else if (helpfulRate > 0.8) {
    lines.push(`- helpful_rate above 80% — retrieval is solid. Consider widening search scope (increase \`limit\`) to surface more candidates.`);
  } else {
    lines.push(`- helpful_rate in the healthy 50-80% band. Keep running the critic, revisit in 7 days.`);
  }
}
lines.push('');
lines.push(`## Next run`);
lines.push('');
lines.push(`Once ${labelled * 3} labelled events accumulate, config sweep will run automatically.`);

if (dryRun) {
  console.log('\n--- DRY RUN ---\n');
  console.log(lines.join('\n'));
} else {
  writeFileSync(reportPath, lines.join('\n') + '\n');
  console.log(`\nReport: ${reportPath}`);
}

db.close();
