#!/usr/bin/env node
/**
 * neuromcp Auto-Context Injection Hook (PreToolUse)
 *
 * Automatically injects relevant memories before each LLM turn.
 * Queries neuromcp HTTP endpoint for semantic matches based on tool input.
 *
 * Setup:
 *   1. Enable HTTP transport: NEUROMCP_HTTP_ENABLED=true
 *   2. Add to Claude Code hooks in settings.json:
 *      {
 *        "hooks": {
 *          "PreToolUse": [{
 *            "type": "command",
 *            "command": "node /path/to/neuromcp-auto-context.js"
 *          }]
 *        }
 *      }
 *
 * Config via env:
 *   NEUROMCP_HTTP_PORT (default: 3200)
 *   NEUROMCP_AUTO_CONTEXT_LIMIT (default: 3)
 *   NEUROMCP_AUTO_CONTEXT_SKIP_TOOLS (default: neuromcp tools)
 */

const NEUROMCP_PORT = process.env.NEUROMCP_HTTP_PORT ?? '3200';
const LIMIT = parseInt(process.env.NEUROMCP_AUTO_CONTEXT_LIMIT ?? '3', 10);
const SKIP_TOOLS = new Set([
  'store_memory', 'search_memory', 'recall_memory', 'forget_memory',
  'consolidate', 'memory_stats', 'export_memories', 'import_memories',
  'backfill_embeddings', 'create_entity', 'create_relation', 'query_graph',
  'search_claims', 'start_episode', 'end_episode', 'list_episodes',
  'get_episode', 'cluster_memories', 'list_clusters', 'get_cluster_memories',
  'summarize_cluster', 'summarize_episode', 'compute_centrality',
  'update_importance', 'memory_timeline', 'register_agent', 'find_expert',
  'agent_conflicts', 'review_queue', 'review_memory', 'init_reviews',
  'compress_memories', 'find_transferable', 'transfer_memories',
]);

// Rate limit: track last query time
const STATE_FILE = '/tmp/neuromcp-auto-context-state.json';
const MIN_INTERVAL_MS = 10000; // 10 seconds between queries

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = input?.tool_name ?? '';

  // Skip neuromcp's own tools
  if (SKIP_TOOLS.has(toolName)) {
    process.exit(0);
  }

  // Rate limit
  try {
    const fs = await import('node:fs');
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Date.now() - (state.lastQuery ?? 0) < MIN_INTERVAL_MS) {
        process.exit(0);
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastQuery: Date.now() }));
  } catch {
    // State file issues are non-fatal
  }

  // Extract search terms from tool input
  const toolInput = JSON.stringify(input?.tool_input ?? {});
  const query = extractKeywords(toolInput);
  if (!query || query.length < 5) {
    process.exit(0);
  }

  // Query neuromcp HTTP API
  try {
    const url = `http://127.0.0.1:${NEUROMCP_PORT}/api/search?q=${encodeURIComponent(query)}&limit=${LIMIT}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) process.exit(0);

    const data = await res.json();
    if (!data.results || data.results.length === 0) process.exit(0);

    // Output context for Claude Code
    const context = data.results
      .map((r) => `[${r.category}] ${r.content}`)
      .join('\n');

    console.log(JSON.stringify({
      additionalContext: `<neuromcp-context>\n${context}\n</neuromcp-context>`,
    }));
  } catch {
    // neuromcp not running or timeout — silent failure
    process.exit(0);
  }
}

function extractKeywords(text) {
  // Simple keyword extraction: remove common words, take top terms
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !STOP_WORDS.has(w));

  // Deduplicate and take top 5
  return [...new Set(words)].slice(0, 5).join(' ');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    setTimeout(() => resolve(data), 1000);
  });
}

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'will',
  'would', 'could', 'should', 'about', 'which', 'there', 'their',
  'what', 'when', 'where', 'true', 'false', 'null', 'undefined',
  'function', 'return', 'const', 'async', 'await', 'import', 'export',
]);

main();
