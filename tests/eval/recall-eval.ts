/**
 * neuromcp Recall Evaluation
 *
 * Tests whether neuromcp can answer real questions about the user's projects
 * and infrastructure. Each question has expected keywords that should appear
 * in the top-k search results.
 *
 * Metrics:
 * - recall@5: % of expected keywords found in top 5 results
 * - precision@5: % of top 5 results that are relevant (not session-end noise)
 * - noise_ratio: % of total memories that are low-value session logs
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const DB_PATH = resolve(homedir(), '.neuromcp/memory.db');

interface EvalQuestion {
  readonly query: string;
  readonly expectedKeywords: readonly string[];
  readonly category: 'project' | 'infrastructure' | 'person' | 'pattern';
}

const EVAL_QUESTIONS: readonly EvalQuestion[] = [
  // Project knowledge
  {
    query: 'What stack does GoAmanah use?',
    expectedKeywords: ['next.js', 'supabase', 'stripe', 'goamanah'],
    category: 'project',
  },
  {
    query: 'What is AgentProofs?',
    expectedKeywords: ['ed25519', 'proof', 'vercel', 'typescript'],
    category: 'project',
  },
  {
    query: 'What is neuromcp and how is it deployed?',
    expectedKeywords: ['npm', 'neuromcp', 'mcp', 'memory'],
    category: 'project',
  },
  {
    query: 'What is DakDeel?',
    expectedKeywords: ['dakopbouw', 'dakdeel'],
    category: 'project',
  },
  // Infrastructure knowledge
  {
    query: 'What MCP servers are active?',
    expectedKeywords: ['neuromcp', 'exa', 'github', 'playwright'],
    category: 'infrastructure',
  },
  {
    query: 'How do I start Paperclip?',
    expectedKeywords: ['paperclip', '3100', 'npx'],
    category: 'infrastructure',
  },
  {
    query: 'What hooks are configured?',
    expectedKeywords: ['hook', 'pre-commit', 'quality'],
    category: 'infrastructure',
  },
  {
    query: 'How many skills are installed?',
    expectedKeywords: ['skill', '123'],
    category: 'infrastructure',
  },
  {
    query: 'What is the tool routing priority?',
    expectedKeywords: ['exa', 'context7', 'firecrawl'],
    category: 'infrastructure',
  },
  // Person knowledge
  {
    query: 'What is the user GitHub account?',
    expectedKeywords: ['adelelo13'],
    category: 'person',
  },
  {
    query: 'What are the user preferences for working?',
    expectedKeywords: ['autonomous', 'permission', 'allow'],
    category: 'person',
  },
  // Pattern knowledge
  {
    query: 'What osascript errors are known?',
    expectedKeywords: ['osascript', 'accessibility', 'permission'],
    category: 'pattern',
  },
  {
    query: 'How does the user typically start sessions?',
    expectedKeywords: ['session', '/users/a', 'operational'],
    category: 'pattern',
  },
  // Cross-cutting questions (should require connecting multiple memories)
  {
    query: 'What platforms are the projects deployed on?',
    expectedKeywords: ['vercel', 'npm'],
    category: 'project',
  },
  {
    query: 'What is dmux used for?',
    expectedKeywords: ['dmux', 'tmux', 'agent', 'pane'],
    category: 'infrastructure',
  },
  // Questions that SHOULD fail (no data stored)
  {
    query: 'What is the Supabase project ID for GoAmanah?',
    expectedKeywords: ['supabase', 'project', 'goamanah'],
    category: 'project',
  },
  {
    query: 'What Apple Developer team ID is configured?',
    expectedKeywords: ['apple', 'developer', 'team'],
    category: 'infrastructure',
  },
  {
    query: 'What GCP project does Adel use?',
    expectedKeywords: ['gcp', 'google', 'cloud'],
    category: 'infrastructure',
  },
  {
    query: 'What is the Stripe webhook secret for GoAmanah?',
    expectedKeywords: ['stripe', 'webhook'],
    category: 'project',
  },
  {
    query: 'What database schema does DakDeel use?',
    expectedKeywords: ['dakdeel', 'schema', 'table'],
    category: 'project',
  },
];

// --- Evaluation logic (FTS-only, no embeddings needed) ---

function ftsSearch(db: Database.Database, query: string, limit: number): Array<{ id: string; content: string; category: string }> {
  // Extract meaningful words (>3 chars, skip stopwords)
  const stopwords = new Set(['what', 'which', 'where', 'when', 'does', 'have', 'that', 'this', 'with', 'from', 'they', 'been', 'were', 'will', 'about', 'many', 'used', 'typically', 'configured', 'active', 'start', 'known', 'how', 'the', 'are', 'for']);
  const words = query.toLowerCase().replace(/[?.,!'"]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));

  // Strategy 1: LIKE with word matching (more reliable than FTS for our use case)
  if (words.length === 0) return [];
  const conditions = words.map(() => 'LOWER(m.content) LIKE ?');
  const params = words.map(w => `%${w}%`);

  // Score by number of matching words (poor man's TF ranking)
  const scoreParts = words.map(() => '(CASE WHEN LOWER(m.content) LIKE ? THEN 1 ELSE 0 END)');
  const scoreParams = words.map(w => `%${w}%`);

  return db.prepare(`
    SELECT m.id, m.content, m.category,
           (${scoreParts.join(' + ')}) as match_score
    FROM memories m
    WHERE m.is_deleted = 0 AND (${conditions.join(' OR ')})
    ORDER BY match_score DESC, m.importance DESC LIMIT ?
  `).all(...scoreParams, ...params, limit) as Array<{ id: string; content: string; category: string }>;
}

function computeRecall(results: readonly { content: string }[], expectedKeywords: readonly string[]): number {
  if (expectedKeywords.length === 0) return 1;
  const combined = results.map(r => r.content.toLowerCase()).join(' ');
  const found = expectedKeywords.filter(kw => combined.includes(kw.toLowerCase()));
  return found.length / expectedKeywords.length;
}

function computePrecision(results: readonly { category: string }[]): number {
  if (results.length === 0) return 0;
  const relevant = results.filter(r => r.category !== 'session');
  return relevant.length / results.length;
}

// --- Main ---

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // DB stats
  const totalMemories = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE is_deleted = 0').get() as { c: number }).c;
  const sessionMemories = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_deleted = 0 AND category = 'session'").get() as { c: number }).c;
  const entityCount = (db.prepare('SELECT COUNT(*) as c FROM entities WHERE is_deleted = 0').get() as { c: number }).c;
  const relationCount = (db.prepare('SELECT COUNT(*) as c FROM relations WHERE is_deleted = 0').get() as { c: number }).c;
  const episodeCount = (db.prepare('SELECT COUNT(*) as c FROM episodes').get() as { c: number }).c;

  console.log('=== neuromcp Recall Evaluation ===\n');
  console.log('DB Stats:');
  console.log(`  Total memories:   ${totalMemories}`);
  console.log(`  Session logs:     ${sessionMemories} (${((sessionMemories / totalMemories) * 100).toFixed(0)}% noise)`);
  console.log(`  Meaningful:       ${totalMemories - sessionMemories}`);
  console.log(`  Entities:         ${entityCount}`);
  console.log(`  Relations:        ${relationCount}`);
  console.log(`  Episodes:         ${episodeCount}`);
  console.log();

  const K = 5;
  let totalRecall = 0;
  let totalPrecision = 0;
  let passed = 0;
  let failed = 0;
  const categoryScores: Record<string, { recall: number; count: number }> = {};

  for (const q of EVAL_QUESTIONS) {
    const results = ftsSearch(db, q.query, K);
    const recall = computeRecall(results, q.expectedKeywords);
    const precision = computePrecision(results);

    totalRecall += recall;
    totalPrecision += precision;

    if (!categoryScores[q.category]) {
      categoryScores[q.category] = { recall: 0, count: 0 };
    }
    categoryScores[q.category].recall += recall;
    categoryScores[q.category].count += 1;

    const status = recall >= 0.5 ? 'PASS' : 'FAIL';
    if (recall >= 0.5) passed++;
    else failed++;

    const icon = status === 'PASS' ? '✓' : '✗';
    console.log(`${icon} [${status}] recall=${(recall * 100).toFixed(0)}% precision=${(precision * 100).toFixed(0)}% | ${q.query}`);
    if (recall < 0.5) {
      const combined = results.map(r => r.content.toLowerCase()).join(' ');
      const missing = q.expectedKeywords.filter(kw => !combined.includes(kw.toLowerCase()));
      console.log(`  Missing: ${missing.join(', ')}`);
      console.log(`  Results: ${results.length} (${results.map(r => r.category).join(', ') || 'none'})`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}/${EVAL_QUESTIONS.length}`);
  console.log(`Failed: ${failed}/${EVAL_QUESTIONS.length}`);
  console.log(`Avg recall@${K}:    ${((totalRecall / EVAL_QUESTIONS.length) * 100).toFixed(1)}%`);
  console.log(`Avg precision@${K}: ${((totalPrecision / EVAL_QUESTIONS.length) * 100).toFixed(1)}%`);
  console.log(`Noise ratio:        ${((sessionMemories / totalMemories) * 100).toFixed(1)}%`);

  console.log('\nBy category:');
  for (const [cat, scores] of Object.entries(categoryScores)) {
    console.log(`  ${cat}: recall=${((scores.recall / scores.count) * 100).toFixed(1)}%`);
  }

  console.log('\n=== Diagnosis ===');
  if (sessionMemories / totalMemories > 0.7) {
    console.log('⚠ CRITICAL: >70% of memories are session-end noise. Consolidation/pruning needed.');
  }
  if (entityCount === 0) {
    console.log('⚠ CRITICAL: Knowledge graph is empty. Entity extraction not running.');
  }
  if (relationCount === 0) {
    console.log('⚠ CRITICAL: No relations. PageRank has nothing to compute.');
  }
  if (episodeCount === 0) {
    console.log('⚠ WARNING: No episodes. Session grouping not active.');
  }
  if (totalMemories - sessionMemories < 20) {
    console.log('⚠ WARNING: Only ' + (totalMemories - sessionMemories) + ' meaningful memories. Need more diverse data.');
  }

  db.close();
}

main();
