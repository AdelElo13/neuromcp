import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { searchMemory } from '../tools/search.js';
import { consolidate } from '../tools/consolidate.js';

export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  const { db, vecStore, embedder, config, logger, metrics } = deps;

  // ─── Prompt 1: memory_context_for_task ─────────────────────────────
  server.registerPrompt('memory_context_for_task', {
    description: 'Search memories relevant to a task and format them as context for an LLM.',
    argsSchema: {
      task: z.string().describe('Description of the task to find relevant memories for'),
      namespace: z.string().optional().describe('Namespace to search'),
      limit: z.string().optional().describe('Max memories to include (default: 5)'),
    },
  }, async (args) => {
    const limit = args.limit !== undefined ? parseInt(args.limit, 10) : 5;
    const results = await searchMemory(
      { query: args.task, namespace: args.namespace, limit },
      { db, vecStore, embedder, logger, metrics, config },
    );

    if (results.length === 0) {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `No relevant memories found for task: "${args.task}"`,
          },
        }],
      };
    }

    const memoryBlock = results.map((m, i) => {
      const tags: string[] = JSON.parse(m.tags);
      return [
        `### Memory ${i + 1} (score: ${m.similarity_score.toFixed(4)})`,
        `- **Category**: ${m.category}`,
        `- **Tags**: ${tags.length > 0 ? tags.join(', ') : 'none'}`,
        `- **Importance**: ${m.importance}`,
        `- **Created**: ${m.created_at}`,
        '',
        m.content,
      ].join('\n');
    }).join('\n\n---\n\n');

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `# Relevant Memories for Task`,
            '',
            `**Task**: ${args.task}`,
            `**Found**: ${results.length} relevant memories`,
            '',
            memoryBlock,
          ].join('\n'),
        },
      }],
    };
  });

  // ─── Prompt 2: review_memory_candidate ─────────────────────────────
  server.registerPrompt('review_memory_candidate', {
    description: 'Show a proposed memory alongside existing near-duplicates to help decide whether to store it.',
    argsSchema: {
      content: z.string().describe('The proposed memory content to review'),
      namespace: z.string().optional().describe('Namespace to check for duplicates'),
    },
  }, async (args) => {
    const namespace = args.namespace ?? config.defaultNamespace;
    const results = await searchMemory(
      { query: args.content, namespace, limit: 5 },
      { db, vecStore, embedder, logger, metrics, config },
    );

    const duplicateBlock = results.length === 0
      ? 'No similar memories found. This appears to be a new topic.'
      : results.map((m, i) => {
          const tags: string[] = JSON.parse(m.tags);
          return [
            `### Existing Memory ${i + 1} (similarity: ${m.similarity_score.toFixed(4)})`,
            `- **ID**: ${m.id}`,
            `- **Category**: ${m.category}`,
            `- **Tags**: ${tags.length > 0 ? tags.join(', ') : 'none'}`,
            `- **Importance**: ${m.importance}`,
            '',
            m.content,
          ].join('\n');
        }).join('\n\n---\n\n');

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            '# Memory Candidate Review',
            '',
            '## Proposed Memory',
            '',
            args.content,
            '',
            `## Existing Similar Memories (namespace: ${namespace})`,
            '',
            duplicateBlock,
            '',
            '## Decision',
            '',
            'Should this memory be stored? Consider:',
            '1. Is it a duplicate of an existing memory?',
            '2. Does it add new information not captured above?',
            '3. Would it be better to update an existing memory instead?',
          ].join('\n'),
        },
      }],
    };
  });

  // ─── Prompt 3: consolidation_dry_run ───────────────────────────────
  server.registerPrompt('consolidation_dry_run', {
    description: 'Preview proposed consolidation actions (merges, decays, prunes, sweeps) without applying them.',
    argsSchema: {
      namespace: z.string().optional().describe('Namespace to consolidate (default: config default)'),
    },
  }, (args) => {
    const output = consolidate(
      { namespace: args.namespace, commit: false },
      db, vecStore, embedder, config, logger, metrics,
    );

    if (output.type !== 'plan') {
      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: 'Unexpected: consolidation returned a result instead of a plan.' },
        }],
      };
    }

    const { plan } = output;
    const sections: string[] = [
      '# Consolidation Dry Run',
      '',
      `**Namespace**: ${plan.namespace}`,
      `**Operation ID**: ${plan.operation_id}`,
      '',
      '## Summary',
      '',
      `- Proposed merges: ${plan.summary.merge_count}`,
      `- Proposed decays: ${plan.summary.decay_count}`,
      `- Proposed prunes: ${plan.summary.prune_count}`,
      `- Proposed TTL sweeps: ${plan.summary.sweep_count}`,
    ];

    if (plan.proposed_merges.length > 0) {
      sections.push('', '## Proposed Merges', '');
      for (const merge of plan.proposed_merges) {
        sections.push(
          `- **Keep** \`${merge.keep_id}\` / **Tombstone** \`${merge.tombstone_id}\``,
          `  Similarity: ${merge.similarity.toFixed(4)} | Reason: ${merge.reason}`,
        );
      }
    }

    if (plan.proposed_decays.length > 0) {
      sections.push('', '## Proposed Decays', '');
      for (const decay of plan.proposed_decays) {
        sections.push(
          `- \`${decay.id}\`: ${decay.current_importance.toFixed(3)} -> ${decay.new_importance.toFixed(3)} (${decay.days_since_access} days since access)`,
        );
      }
    }

    if (plan.proposed_prunes.length > 0) {
      sections.push('', '## Proposed Prunes', '');
      for (const prune of plan.proposed_prunes) {
        sections.push(
          `- \`${prune.id}\`: importance=${prune.importance.toFixed(3)}, accesses=${prune.access_count}, age=${prune.age_days}d | ${prune.reason}`,
        );
      }
    }

    if (plan.proposed_ttl_sweeps.length > 0) {
      sections.push('', '## Proposed TTL Sweeps', '');
      for (const sweep of plan.proposed_ttl_sweeps) {
        sections.push(`- \`${sweep.id}\`: expired at ${sweep.expired_at}`);
      }
    }

    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: sections.join('\n') },
      }],
    };
  });
}
