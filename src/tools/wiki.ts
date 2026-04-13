import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { Logger } from '../observability/logger.js';
import type { NeuromcpConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface Frontmatter {
  readonly title?: string;
  readonly type?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly confidence?: string;
  readonly related?: readonly string[];
  readonly source?: string;
}

interface WikiPage {
  readonly path: string;
  readonly slug: string;
  readonly folder: string;
  readonly frontmatter: Frontmatter;
  readonly bodyLines: number;
  readonly rawContent: string;
}

type LintSeverity = 'critical' | 'warning' | 'suggestion';

interface LintIssue {
  readonly severity: LintSeverity;
  readonly page: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Frontmatter; bodyLineCount: number } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, bodyLineCount: lines.length };
  }

  const endIdx = lines.indexOf('---', 1);
  if (endIdx === -1) {
    return { frontmatter: {}, bodyLineCount: lines.length };
  }

  const yamlBlock = lines.slice(1, endIdx);
  const fm: Record<string, unknown> = {};

  for (const line of yamlBlock) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, rawValue] = match;
      const value = rawValue!.trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        fm[key!] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        fm[key!] = value;
      }
    }
  }

  const bodyLines = lines.slice(endIdx + 1).filter((l) => l.trim().length > 0);
  return { frontmatter: fm as unknown as Frontmatter, bodyLineCount: bodyLines.length };
}

function collectPages(wikiDir: string): readonly WikiPage[] {
  const contentDirs = ['people', 'projects', 'systems', 'patterns', 'skills', 'decisions'];
  const pages: WikiPage[] = [];

  for (const dir of contentDirs) {
    const dirPath = join(wikiDir, dir);
    if (!existsSync(dirPath)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of entries) {
      const filePath = join(dirPath, file);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const { frontmatter, bodyLineCount } = parseFrontmatter(raw);
        pages.push({
          path: filePath,
          slug: file.replace(/\.md$/, ''),
          folder: dir,
          frontmatter,
          bodyLines: bodyLineCount,
          rawContent: raw,
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  return pages;
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function daysSince(dateStr: string): number {
  const then = new Date(dateStr);
  if (Number.isNaN(then.getTime())) return Infinity;
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// wiki_ingest
// ---------------------------------------------------------------------------

export interface IngestInput {
  readonly filename: string;
}

export interface IngestDeps {
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
}

interface IngestResult {
  readonly filename: string;
  readonly file_path: string;
  readonly file_size_bytes: number;
  readonly content: string;
  readonly metadata: {
    readonly suggested_title: string;
    readonly suggested_type: string;
    readonly key_concepts: readonly string[];
    readonly mentioned_people: readonly string[];
    readonly mentioned_projects: readonly string[];
    readonly mentioned_tools: readonly string[];
  };
  readonly existing_pages: {
    readonly potentially_related: readonly string[];
    readonly index_entries: readonly string[];
  };
  readonly suggestions: readonly string[];
}

export function wikiIngest(input: IngestInput, deps: IngestDeps): IngestResult {
  const { config, logger } = deps;
  const wikiDir = config.wikiDir;
  const rawDir = join(wikiDir, 'raw-sources');
  const filePath = join(rawDir, input.filename);

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${input.filename} in ${rawDir}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const stats = statSync(filePath);
  const lines = content.split('\n');

  // Extract title: first heading or filename
  const headingLine = lines.find((l) => l.startsWith('# '));
  const suggestedTitle = headingLine
    ? headingLine.replace(/^#+\s*/, '').trim()
    : input.filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');

  // Guess type from content keywords
  const lowerContent = content.toLowerCase();
  const typeHints: Array<[string, readonly string[]]> = [
    ['person', ['author:', 'bio', 'profile', 'twitter', '@']],
    ['project', ['github', 'npm', 'deploy', 'stack', 'architecture', 'v0.', 'v1.', 'v2.']],
    ['system', ['config', 'setup', 'install', 'server', 'infrastructure']],
    ['pattern', ['pattern', 'approach', 'method', 'strategy', 'workflow']],
    ['decision', ['decision', 'chose', 'trade-off', 'tradeoff', 'alternative', 'why we']],
    ['skill', ['procedure', 'how to', 'step 1', 'step 2', 'checklist', 'recipe']],
  ];

  let suggestedType = 'pattern'; // default
  let bestScore = 0;
  for (const [type, keywords] of typeHints) {
    const score = keywords.reduce((acc, kw) => acc + (lowerContent.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      suggestedType = type;
    }
  }

  // Extract key concepts: headings and bold terms
  const headings = lines
    .filter((l) => /^#{2,4}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim());

  const boldTerms = [...content.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((m) => m[1]!.trim())
    .filter((t) => t.length > 2 && t.length < 60);

  const keyConcepts = [...new Set([...headings, ...boldTerms])].slice(0, 20);

  // Extract mentions of people (@ handles, "Author:" lines)
  const mentionedPeople = [...new Set([
    ...content.matchAll(/@(\w{2,30})/g),
  ].map((m) => m[1]!))].slice(0, 10);

  // Scan for project/tool names from existing wiki pages
  const pages = collectPages(wikiDir);
  const allSlugs = pages.map((p) => p.slug);
  const mentionedProjects: string[] = [];
  const mentionedTools: string[] = [];

  for (const page of pages) {
    if (lowerContent.includes(page.slug.toLowerCase())) {
      if (page.folder === 'projects') {
        mentionedProjects.push(page.slug);
      } else if (page.folder === 'systems') {
        mentionedTools.push(page.slug);
      }
    }
  }

  // Find potentially related existing pages (by slug mention in content)
  const potentiallyRelated = allSlugs.filter((slug) =>
    lowerContent.includes(slug.toLowerCase()),
  );

  // Check index.md for existing entries
  const indexContent = readFileOrNull(join(wikiDir, 'index.md')) ?? '';
  const indexEntries = allSlugs.filter((slug) => indexContent.includes(slug));

  // Generate suggestions
  const suggestions: string[] = [];
  suggestions.push(`Create or update wiki pages based on the key concepts extracted from "${input.filename}".`);

  if (mentionedProjects.length > 0) {
    suggestions.push(`Update existing project pages: ${mentionedProjects.join(', ')}`);
  }

  const newConcepts = keyConcepts.filter((c) =>
    !allSlugs.some((s) => s.toLowerCase() === c.toLowerCase().replace(/\s+/g, '-')),
  );
  if (newConcepts.length > 0) {
    suggestions.push(`Consider creating new pages for: ${newConcepts.slice(0, 5).join(', ')}`);
  }

  suggestions.push('After processing, append an entry to log.md documenting what was ingested and which pages were created/updated.');
  suggestions.push(`Mark this source as processed in log.md with: "Source: raw-sources/${input.filename}"`);

  logger.info('wiki', 'wiki_ingest completed', {
    filename: input.filename,
    concepts: keyConcepts.length,
    related: potentiallyRelated.length,
  });

  return {
    filename: input.filename,
    file_path: filePath,
    file_size_bytes: stats.size,
    content,
    metadata: {
      suggested_title: suggestedTitle,
      suggested_type: suggestedType,
      key_concepts: keyConcepts,
      mentioned_people: mentionedPeople,
      mentioned_projects: mentionedProjects,
      mentioned_tools: mentionedTools,
    },
    existing_pages: {
      potentially_related: potentiallyRelated,
      index_entries: indexEntries,
    },
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// wiki_lint
// ---------------------------------------------------------------------------

export interface LintDeps {
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
}

interface LintReport {
  readonly total_pages: number;
  readonly issues: readonly LintIssue[];
  readonly summary: {
    readonly critical: number;
    readonly warning: number;
    readonly suggestion: number;
  };
  readonly report_path: string;
}

export function wikiLint(deps: LintDeps): LintReport {
  const { config, logger } = deps;
  const wikiDir = config.wikiDir;
  const issues: LintIssue[] = [];

  // Collect all wiki pages
  const pages = collectPages(wikiDir);

  // Load index.md
  const indexContent = readFileOrNull(join(wikiDir, 'index.md')) ?? '';

  // Load log.md
  const logContent = readFileOrNull(join(wikiDir, 'log.md')) ?? '';

  // Check 1: Missing frontmatter
  for (const page of pages) {
    if (!page.frontmatter.title && !page.frontmatter.type) {
      issues.push({
        severity: 'critical',
        page: `${page.folder}/${page.slug}.md`,
        message: 'Missing frontmatter: no title or type fields found',
      });
    } else {
      if (!page.frontmatter.title) {
        issues.push({
          severity: 'warning',
          page: `${page.folder}/${page.slug}.md`,
          message: 'Missing frontmatter field: title',
        });
      }
      if (!page.frontmatter.type) {
        issues.push({
          severity: 'warning',
          page: `${page.folder}/${page.slug}.md`,
          message: 'Missing frontmatter field: type',
        });
      }
      if (!page.frontmatter.updated) {
        issues.push({
          severity: 'warning',
          page: `${page.folder}/${page.slug}.md`,
          message: 'Missing frontmatter field: updated',
        });
      }
    }
  }

  // Check 2: Pages not in index.md
  for (const page of pages) {
    if (!indexContent.includes(page.slug)) {
      issues.push({
        severity: 'warning',
        page: `${page.folder}/${page.slug}.md`,
        message: 'Page not referenced in index.md',
      });
    }
  }

  // Check 3: Stale pages (updated >30 days ago)
  for (const page of pages) {
    if (page.frontmatter.updated) {
      const age = daysSince(page.frontmatter.updated);
      if (age > 30) {
        issues.push({
          severity: 'warning',
          page: `${page.folder}/${page.slug}.md`,
          message: `Stale page: last updated ${age} days ago (${page.frontmatter.updated})`,
        });
      }
    }
  }

  // Check 4: Thin pages (<5 lines of content after frontmatter)
  for (const page of pages) {
    if (page.bodyLines < 5) {
      issues.push({
        severity: 'suggestion',
        page: `${page.folder}/${page.slug}.md`,
        message: `Thin page: only ${page.bodyLines} lines of content after frontmatter`,
      });
    }
  }

  // Check 5: Unprocessed raw-sources (not mentioned in log.md)
  const rawDir = join(wikiDir, 'raw-sources');
  if (existsSync(rawDir)) {
    try {
      const rawFiles = readdirSync(rawDir).filter((f) => f.endsWith('.md'));
      for (const file of rawFiles) {
        if (!logContent.includes(file)) {
          issues.push({
            severity: 'critical',
            page: `raw-sources/${file}`,
            message: 'Unprocessed source: file not mentioned in log.md',
          });
        }
      }
    } catch {
      // skip if directory unreadable
    }
  }

  // Check 6: Broken related links
  const allSlugs = new Set(pages.map((p) => p.slug));
  for (const page of pages) {
    if (page.frontmatter.related) {
      for (const rel of page.frontmatter.related) {
        if (!allSlugs.has(rel)) {
          issues.push({
            severity: 'suggestion',
            page: `${page.folder}/${page.slug}.md`,
            message: `Broken related link: "${rel}" does not match any wiki page slug`,
          });
        }
      }
    }
  }

  const summary = {
    critical: issues.filter((i) => i.severity === 'critical').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    suggestion: issues.filter((i) => i.severity === 'suggestion').length,
  };

  // Write lint-report.md
  const reportLines: string[] = [
    `# Wiki Lint Report — ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Summary',
    `- Total pages: ${pages.length}`,
    `- Issues found: ${issues.length} (critical: ${summary.critical}, warnings: ${summary.warning}, suggestions: ${summary.suggestion})`,
    '',
  ];

  const grouped: Record<LintSeverity, readonly LintIssue[]> = {
    critical: issues.filter((i) => i.severity === 'critical'),
    warning: issues.filter((i) => i.severity === 'warning'),
    suggestion: issues.filter((i) => i.severity === 'suggestion'),
  };

  if (grouped.critical.length > 0) {
    reportLines.push('## Critical (fix now)', '');
    for (const issue of grouped.critical) {
      reportLines.push(`- **${issue.page}**: ${issue.message}`);
    }
    reportLines.push('');
  }

  if (grouped.warning.length > 0) {
    reportLines.push('## Warnings (fix soon)', '');
    for (const issue of grouped.warning) {
      reportLines.push(`- **${issue.page}**: ${issue.message}`);
    }
    reportLines.push('');
  }

  if (grouped.suggestion.length > 0) {
    reportLines.push('## Suggestions (nice to have)', '');
    for (const issue of grouped.suggestion) {
      reportLines.push(`- **${issue.page}**: ${issue.message}`);
    }
    reportLines.push('');
  }

  const reportPath = join(wikiDir, 'lint-report.md');
  writeFileSync(reportPath, reportLines.join('\n'), 'utf-8');

  logger.info('wiki', 'wiki_lint completed', {
    pages: pages.length,
    issues: issues.length,
    critical: summary.critical,
  });

  return {
    total_pages: pages.length,
    issues,
    summary,
    report_path: reportPath,
  };
}

// ---------------------------------------------------------------------------
// wiki_briefing
// ---------------------------------------------------------------------------

export interface BriefingInput {
  readonly days?: number;
}

export interface BriefingDeps {
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
}

interface BriefingProject {
  readonly slug: string;
  readonly title: string;
  readonly updated: string;
  readonly confidence: string;
  readonly days_since_update: number;
}

interface BriefingResult {
  readonly generated_at: string;
  readonly lookback_days: number;
  readonly active_projects: readonly BriefingProject[];
  readonly stale_projects: readonly BriefingProject[];
  readonly unprocessed_sources: readonly string[];
  readonly recent_changelog: readonly string[];
  readonly stale_pages: readonly { readonly page: string; readonly days_stale: number }[];
  readonly page_count: number;
  readonly lint_summary: {
    readonly has_report: boolean;
    readonly report_date: string | null;
  };
}

export function wikiBriefing(input: BriefingInput, deps: BriefingDeps): BriefingResult {
  const { config, logger } = deps;
  const wikiDir = config.wikiDir;
  const lookbackDays = input.days ?? 7;

  const pages = collectPages(wikiDir);

  // Categorize projects
  const projectPages = pages.filter((p) => p.folder === 'projects');
  const activeProjects: BriefingProject[] = [];
  const staleProjects: BriefingProject[] = [];

  for (const page of projectPages) {
    const updated = page.frontmatter.updated ?? page.frontmatter.created ?? '';
    const age = daysSince(updated);
    const entry: BriefingProject = {
      slug: page.slug,
      title: page.frontmatter.title ?? page.slug,
      updated,
      confidence: page.frontmatter.confidence ?? 'unknown',
      days_since_update: age,
    };

    if (age <= lookbackDays) {
      activeProjects.push(entry);
    } else {
      staleProjects.push(entry);
    }
  }

  // Unprocessed raw sources
  const logContent = readFileOrNull(join(wikiDir, 'log.md')) ?? '';
  const unprocessedSources: string[] = [];
  const rawDir = join(wikiDir, 'raw-sources');
  if (existsSync(rawDir)) {
    try {
      const rawFiles = readdirSync(rawDir).filter((f) => f.endsWith('.md'));
      for (const file of rawFiles) {
        if (!logContent.includes(file)) {
          unprocessedSources.push(file);
        }
      }
    } catch {
      // skip
    }
  }

  // Recent changelog entries (within lookback period)
  const logLines = logContent.split('\n');
  const recentEntries: string[] = [];
  let currentDate = '';

  for (const line of logLines) {
    const dateMatch = line.match(/^##\s*\[?(\d{4}-\d{2}-\d{2})\]?/);
    if (dateMatch) {
      currentDate = dateMatch[1]!;
    }
    if (currentDate && daysSince(currentDate) <= lookbackDays && line.trim().startsWith('- ')) {
      recentEntries.push(`[${currentDate}] ${line.trim().slice(2)}`);
    }
  }

  // Stale pages across all folders
  const stalePages: Array<{ page: string; days_stale: number }> = [];
  for (const page of pages) {
    if (page.frontmatter.updated) {
      const age = daysSince(page.frontmatter.updated);
      if (age > lookbackDays) {
        stalePages.push({
          page: `${page.folder}/${page.slug}.md`,
          days_stale: age,
        });
      }
    }
  }

  // Sort stale pages by staleness (most stale first)
  stalePages.sort((a, b) => b.days_stale - a.days_stale);

  // Lint report status
  const lintPath = join(wikiDir, 'lint-report.md');
  let lintReportDate: string | null = null;
  const hasLintReport = existsSync(lintPath);
  if (hasLintReport) {
    const lintContent = readFileOrNull(lintPath) ?? '';
    const lintDateMatch = lintContent.match(/(\d{4}-\d{2}-\d{2})/);
    if (lintDateMatch) {
      lintReportDate = lintDateMatch[1]!;
    }
  }

  logger.info('wiki', 'wiki_briefing generated', {
    active_projects: activeProjects.length,
    stale_projects: staleProjects.length,
    unprocessed: unprocessedSources.length,
    stale_pages: stalePages.length,
  });

  return {
    generated_at: new Date().toISOString(),
    lookback_days: lookbackDays,
    active_projects: activeProjects,
    stale_projects: staleProjects,
    unprocessed_sources: unprocessedSources,
    recent_changelog: recentEntries,
    stale_pages: stalePages,
    page_count: pages.length,
    lint_summary: {
      has_report: hasLintReport,
      report_date: lintReportDate,
    },
  };
}
