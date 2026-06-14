#!/usr/bin/env node
/**
 * neuromcp-dedup-entity-names — one-time merge of duplicate entity rows that
 * accumulated under the pre-v0.26 (name, entity_type, namespace) upsert key.
 *
 * DESTRUCTIVE (losers are soft-deleted, links re-pointed). Defaults to
 * dry-run: it prints the merge plan and exits. Re-run with --apply to
 * execute. Always review the dry-run output first.
 *
 * Usage:
 *   npx neuromcp-dedup-entity-names            # dry-run (plan only)
 *   npx neuromcp-dedup-entity-names --apply    # execute the merge
 *   NEUROMCP_DB_PATH=/path/to/memory.db ...    # non-default DB
 */
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { openDatabase, closeDatabase } = await import(
  resolve(__dirname, '..', 'dist', 'storage', 'database.js')
);
const { mergeDuplicateEntityNames } = await import(
  resolve(__dirname, '..', 'dist', 'graph', 'entity-name-dedup.js')
);

const apply = process.argv.includes('--apply');
const dbPath = process.env.NEUROMCP_DB_PATH ?? resolve(homedir(), '.neuromcp', 'memory.db');

const db = openDatabase(dbPath);
try {
  const result = mergeDuplicateEntityNames(db, { dryRun: !apply });

  if (result.proposed.length === 0) {
    process.stdout.write('No duplicate entity names found — nothing to merge.\n');
  } else if (!apply) {
    process.stdout.write(`DRY-RUN — ${result.proposed.length} merge(s) proposed (nothing changed):\n\n`);
    for (const p of result.proposed) {
      process.stdout.write(
        `  ${p.key}\n    winner: ${p.winnerId} (${p.winnerType}) "${p.winnerName}"\n    loser:  ${p.loserId} (${p.loserType})\n`,
      );
    }
    process.stdout.write('\nRe-run with --apply to execute.\n');
  } else {
    process.stdout.write(
      `APPLIED — merged ${result.merged} duplicate(s); re-pointed ${result.relinked_memory_entities} memory link(s) and ${result.relinked_relations} relation(s).\n`,
    );
  }
} finally {
  closeDatabase();
}
