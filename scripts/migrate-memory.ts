import { OllamaEmbeddingProvider } from '../src/embeddings/ollama.ts';
import { openDatabase, closeDatabase } from '../src/storage/database.ts';
import { runMigrations } from '../src/storage/migrations.ts';
import { applySchema } from '../src/storage/schema.ts';
import { SqliteVecStore } from '../src/vectors/sqlite-vec.ts';
import { storeMemory } from '../src/tools/store.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/observability/logger.ts';
import { createMetrics } from '../src/observability/metrics.ts';

const graph = {
  "entities": [
    {"name":"User","entityType":"person","observations":["GitHub account: AdelElo13","Hates clicking Allow — full wildcard * permissions, autonomous mode","Full send mentality — do everything, ask less, no hand-holding","Prefers trash/mv ~/.Trash/ over rm -rf for deletions — only rm -rf for ephemeral files (temp dirs, caches, build artifacts)","Reachable via terminal or Telegram","Wants Claude as Jarvis — personal AI assistant with full Mac control, not just code","Has built 3 AI assistant systems: JarvisMac.app (Swift), jarvis_assistant_v2 (Python), DockWright (Swift) — deep understanding of agent architecture","Lives in Amsterdam, speaks Dutch and English, codes primarily in Python and Swift","Builder mindset — wants things working, not discussed. Iterates fast."]},
    {"name":"Mac Setup","entityType":"system","observations":["Platform: macOS Darwin, Apple Silicon (aarch64)","Shell: zsh","Home directory: /Users/a","Claude Code version: v2.1.91+","Permission mode: autonomous, wildcard * allow all","Git attribution disabled globally via settings.json","Python 3.12 installed via uv at ~/.local/bin and /opt/homebrew/bin","uv installed at /opt/homebrew/bin/uv and ~/.local/bin/uv","Running apps (observed 2026-04-04): Finder, Ollama, Mail, Chrome, ChatGPT, Terminal, Xcode, Safari, Outlook, Codex, Console, Claude, Notes","Dark mode enabled","Ollama running — local LLM inference available","Docker available (GitHub MCP runs via docker)"]},
    {"name":"MCP Servers","entityType":"infrastructure","observations":["Local MCPs: neuromcp (semantic memory), exa (web search), context7 (library docs), github (docker, PRs/issues/code search), playwright (browser automation), ollama (local LLM)","Cloud MCPs (active): Gmail, Google Calendar, Figma, Hugging Face, Scholar Gateway","Cloud MCPs (disconnected 2026-04-04): ClickUp, Canva, Craft, PayPal, Play Sheet Music — removed for context savings","Disabled plugins (2026-04-04): firebase, deploy-on-aws, aws-serverless, huggingface-skills — re-enable when needed","Firecrawl plugin enabled for web scraping"]},
    {"name":"Paperclip","entityType":"tool","observations":["Multi-agent orchestration platform at http://127.0.0.1:3100","Start with: npx paperclipai run","Claude acts as CEO — creates companies, hires agents, assigns tasks","Embedded PostgreSQL on port 54329","Not currently running — needs 'npx paperclipai run' to start"]},
    {"name":"dmux","entityType":"tool","observations":["tmux pane manager for running multiple Claude instances","Config at ~/.dmux/","3 panes configured: main (coordinator), research (search/discovery), builder (code/tests)","Use for parallel agent workflows when Paperclip is overkill"]},
    {"name":"ECC Hooks","entityType":"infrastructure","observations":["25+ hooks configured in ~/.claude/settings.json","Pre-commit: blocks --no-verify, quality checks, secret detection","Pre-Bash: tmux reminders, auto-start dev servers","Post-Edit/Write: auto-formatting, lint checks","Stop: session save, verification, cost tracking, desktop notifications","config-protection.js: blocks edits to linter/formatter configs — protects against agents weakening lint rules","continuous-learning-v2 hooks: observe on pre/post tool use, extract patterns","insaits-security wrapper: security monitoring on Bash/Write/Edit","error-learning.js (PostToolUseFailure): logs tool failures to ~/.claude/error_memory.jsonl"]},
    {"name":"Tool Routing","entityType":"reference","observations":["Code/technical search → Exa MCP (not WebSearch)","Library docs → Context7 MCP (not WebSearch)","Web scraping → Firecrawl MCP (not WebFetch)","JS-heavy sites → Playwright MCP","Academic papers → Scholar Gateway MCP","Multi-agent work → Paperclip or dmux","Existing repos/code → GitHub MCP (gh search code)","Semantic memory → neuromcp (store_memory, search_memory)"]},
    {"name":"Skills","entityType":"infrastructure","observations":["123+ skills installed at ~/.claude/skills/","Key skills for Mac control: sensory (osascript), sensory/references/apps.md (18 app recipes)","Key skills for research: deep-research, exa-search, docs-lookup, market-research","Key skills for development: tdd-workflow, plan, code-review, build-fix, security-review","Key skills for content: article-writing, brand-voice, content-engine, crosspost, frontend-slides, manim-video, video-editing","Key skills for orchestration: paperclip, dmux-workflows, autonomous-loops, claude-devfleet, team-builder","Key skills for ops: save-session, resume-session, schedule, loop, configure-ecc, workspace-surface-audit"]},
    {"name":"Mac Control","entityType":"capability","observations":["Primary method: osascript via Bash tool (AppleScript/Accessibility API)","Tier 1 (no permissions): direct app scripting, Finder, Safari/Chrome tabs, Mail, Notes, Calendar, Spotify, shell commands, volume, dark mode, clipboard, notifications, URLs, window bounds","Tier 2 (needs Accessibility): System Events UI control — keystroke simulation, button clicking, form filling, menu navigation, UI element discovery","Accessibility permissions: GRANTED","Sensory skill at ~/.claude/skills/sensory/ — full reference for macOS automation","Can control: Finder, Safari, Chrome, Mail, Notes, Calendar, Terminal, Xcode, Outlook, Messages, System Settings, Spotlight, Shortcuts.app","Limitations: no sandboxed banking apps, no GPU-rendered game UIs, no web page DOM (use JS injection), no Touch Bar, no FileVault login"]},
    {"name":"Error Patterns","entityType":"learning","observations":["osascript 'not allowed assistive access' (-25211): needs Accessibility permissions","osascript 'Can't get window 1' (-1719): app has no windows, activate first","osascript 'Process not running' (-10810): launch app before scripting","MCP tool failures: if server disconnects, tools vanish — fall back to Bash","Permission prompts on settings.json edits: hardcoded Claude Code safety guardrail, cannot be disabled","Permission prompts on osascript: Bash flags computer-control commands as sensitive","config-protection.js blocks linter/formatter config edits — intentional, fix code not config","bun PATH must be in .zshenv not .zshrc for MCP servers","Always use trash instead of rm -rf for user files"]},
    {"name":"Self Awareness","entityType":"meta","observations":["Claude Code (Opus 4.6, 1M context) running in Terminal on macOS","Local MCPs: neuromcp, exa, context7, github, playwright, ollama","Memory via neuromcp with Ollama nomic-embed-text for semantic search","Dream consolidation enabled (autoDreamEnabled: true in settings.json)","Can control Mac via osascript, browse via Playwright, search via Exa/Context7/GitHub, orchestrate via Paperclip/dmux","Context window ~1M tokens, 5-7% used at startup","Known blind spots: cannot disconnect cloud MCPs, cannot override hardcoded permission prompts","User's other AI systems: JarvisMac.app, DockWright, jarvis_assistant_v2"]},
    {"name":"Session Patterns","entityType":"learning","observations":["User starts sessions from /Users/a (home dir) for operational work, not coding","Common session types: MCP/tool management, cross-project coordination, Mac automation, research","User prefers terse responses, no trailing summaries, no emoji unless asked","User wants zero permission prompts","When user says 'delete' or 'remove', they mean now — don't ask confirmation","User speaks fast, typos common — interpret intent not literal spelling","User knows their system deeply — don't over-explain, focus on action"]},
    {"name":"neuromcp","entityType":"product","observations":["npm package: neuromcp@0.1.1, published 2026-04-04","GitHub: AdelElo13/neuromcp","Local-first MCP memory server with hybrid search, governance, consolidation","8 tools, 13 resources, 3 prompts, 170 tests","Ollama + nomic-embed-text for real semantic embeddings (768-dim)","ONNX bge-small fallback (384-dim, keyword-quality only)","SQLite + sqlite-vec storage, WAL mode","Plan-then-commit consolidation, namespace isolation, trust levels, soft delete"]}
  ]
};

async function migrate() {
  const config = loadConfig();
  const logger = createLogger({ level: 'info', format: 'text' });
  const metrics = createMetrics();
  
  const embedder = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
  if (!(await embedder.isAvailable())) {
    console.error('Ollama not available');
    process.exit(1);
  }
  console.log('Embedding dimensions:', embedder.dimensions);

  const dbPath = config.dbPath;
  console.log('DB path:', dbPath);
  const db = openDatabase(dbPath);
  runMigrations(db, dbPath, logger);
  
  const vecStore = new SqliteVecStore(embedder.dimensions);
  vecStore.initialize(db);

  let stored = 0;
  let deduped = 0;

  for (const entity of graph.entities) {
    // Store entity as a summary memory
    const entityContent = `[${entity.entityType}] ${entity.name}: ${entity.observations.join('. ')}`;
    const result = await storeMemory(
      {
        content: entityContent,
        category: entity.entityType,
        tags: [entity.name.toLowerCase().replace(/\s+/g, '-'), entity.entityType],
        importance: entity.entityType === 'person' ? 0.9 : entity.entityType === 'learning' ? 0.8 : 0.7,
        source: 'user',
        namespace: 'default',
      },
      { db, vecStore, embedder, config, logger, metrics }
    );
    
    if (result.matched) {
      deduped++;
    } else {
      stored++;
    }
    console.log(`  ${result.matched ? 'DEDUP' : 'NEW  '} [${entity.entityType}] ${entity.name} (${entity.observations.length} observations)`);
  }

  console.log(`\nMigration complete: ${stored} stored, ${deduped} deduped`);
  closeDatabase();
}

migrate().catch(e => { console.error(e); process.exit(1); });
