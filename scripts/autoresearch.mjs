#!/usr/bin/env node
/**
 * autoresearch.mjs — weekly self-optimisation loop.
 *
 * Codex's correction over my original plan: don't benchmark-chase
 * LongMemEval in isolation. Track real user outcomes (critic acceptance
 * rate from memory_usefulness) and only promote config variants that
 * improve helpful_rate in production.
 *
 * Variants tried each cycle (edit the CONFIGS array to add more):
 *   - attentionWeight = 0.002 | 0.004 | 0.008
 *   - usefulnessFactor slope = 0.3 | 0.5 | 0.7
 *
 * Results are written to ~/.neuromcp/experiments/<timestamp>.md so you
 * can review the evidence before the auto-promoter changes defaults.
 *
 * Usage:
 *   node scripts/autoresearch.mjs            # full cycle
 *   node scripts/autoresearch.mjs --dry-run  # plan only
 *   node scripts/autoresearch.mjs --promote  # apply winner if lift > threshold
 *
 * Schedule via launchd for weekly autonomous runs.
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
const promote = args.includes('--promote');
const promoteThreshold = 0.05; // need 5% improvement to promote

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
  console.log(`\nNot enough labelled data (< 10 events). Skipping config sweep.`);
  console.log(`Call log_retrieval with outcomes on at least 10 searches before running autoresearch.`);
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
  `# neuromcp autoresearch report — ${new Date().toISOString()}`,
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

if (promote && helpfulRate !== null && helpfulRate > 0.7) {
  console.log(`\npromote=true and helpful_rate=${helpfulRate.toFixed(3)} > 0.7 — current config is already good, no promotion needed.`);
} else if (promote) {
  console.log(`\npromote=true but signal insufficient or below threshold. No change.`);
}

db.close();
