/**
 * Run entity extraction on all active memories.
 * Uses regex extraction (no LLM dependency for reliability).
 * Then runs LLM extraction for richer results.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { extractEntities } from '../../src/graph/extract.js';
import { extractWithLLM } from '../../src/graph/llm-extract.js';
import { upsertEntity, linkMemoryEntity } from '../../src/graph/entities.js';
import { createRelation } from '../../src/graph/relations.js';

const DB_PATH = resolve(homedir(), '.neuromcp/memory.db');

async function main() {
  const db = new Database(DB_PATH);

  // Get all active memories
  const memories = db.prepare(
    'SELECT id, content, namespace FROM memories WHERE is_deleted = 0'
  ).all() as Array<{ id: string; content: string; namespace: string }>;

  console.log(`Processing ${memories.length} memories...\n`);

  // Phase 1: Regex extraction
  console.log('=== Phase 1: Regex Extraction ===');
  let totalRegexEntities = 0;
  for (const mem of memories) {
    const entities = extractEntities(db, mem.id, mem.content, mem.namespace);
    if (entities.length > 0) {
      console.log(`  ${mem.content.slice(0, 50)}... → ${entities.length} entities`);
      for (const e of entities) {
        console.log(`    - ${e.name} (${e.entity_type})`);
      }
      totalRegexEntities += entities.length;
    }
  }
  console.log(`\nRegex total: ${totalRegexEntities} entities\n`);

  // Phase 2: LLM extraction (Ollama)
  console.log('=== Phase 2: LLM Extraction ===');
  const ollamaHost = 'http://localhost:11434';
  const model = 'llama3.2:3b';
  let totalLLMEntities = 0;
  let totalRelations = 0;

  for (const mem of memories) {
    try {
      const result = await extractWithLLM(mem.content, ollamaHost, model);

      if (result.entities.length > 0) {
        const entityMap = new Map<string, string>();

        for (const e of result.entities) {
          const entity = upsertEntity(db, e.name, e.type, mem.namespace);
          linkMemoryEntity(db, mem.id, entity.id);
          entityMap.set(e.name.toLowerCase(), entity.id);
          totalLLMEntities++;
        }

        for (const r of result.relations) {
          const sourceId = entityMap.get(r.source.toLowerCase());
          const targetId = entityMap.get(r.target.toLowerCase());
          if (sourceId && targetId) {
            createRelation(db, sourceId, targetId, r.type, mem.namespace);
            totalRelations++;
          }
        }

        console.log(`  ${mem.content.slice(0, 50)}... → ${result.entities.length} entities, ${result.relations.length} relations`);
      }
    } catch (err) {
      console.log(`  SKIP: ${mem.content.slice(0, 40)}... (${(err as Error).message})`);
    }
  }
  console.log(`\nLLM total: ${totalLLMEntities} entities, ${totalRelations} relations\n`);

  // Summary
  const entityCount = (db.prepare('SELECT COUNT(*) as c FROM entities WHERE is_deleted = 0').get() as { c: number }).c;
  const relationCount = (db.prepare('SELECT COUNT(*) as c FROM relations WHERE is_deleted = 0').get() as { c: number }).c;
  const linkCount = (db.prepare('SELECT COUNT(*) as c FROM memory_entities').get() as { c: number }).c;

  console.log('=== Final Knowledge Graph ===');
  console.log(`Entities:  ${entityCount}`);
  console.log(`Relations: ${relationCount}`);
  console.log(`Links:     ${linkCount} (memory↔entity)`);

  // Show top entities
  console.log('\nTop entities:');
  const topEntities = db.prepare(`
    SELECT e.name, e.entity_type, COUNT(me.memory_id) as mem_count
    FROM entities e
    JOIN memory_entities me ON me.entity_id = e.id
    WHERE e.is_deleted = 0
    GROUP BY e.id
    ORDER BY mem_count DESC
    LIMIT 20
  `).all() as Array<{ name: string; entity_type: string; mem_count: number }>;

  for (const e of topEntities) {
    console.log(`  ${e.name} (${e.entity_type}) — ${e.mem_count} memories`);
  }

  // Show relations
  if (relationCount > 0) {
    console.log('\nRelations:');
    const relations = db.prepare(`
      SELECT e1.name as src, r.relation_type, e2.name as tgt
      FROM relations r
      JOIN entities e1 ON e1.id = r.source_entity_id
      JOIN entities e2 ON e2.id = r.target_entity_id
      WHERE r.is_deleted = 0
      ORDER BY r.weight DESC
      LIMIT 30
    `).all() as Array<{ src: string; relation_type: string; tgt: string }>;

    for (const r of relations) {
      console.log(`  ${r.src} —[${r.relation_type}]→ ${r.tgt}`);
    }
  }

  db.close();
}

main().catch(console.error);
