import type Database from 'better-sqlite3';

export interface AgentProfile {
  readonly agent_id: string;
  readonly name: string;
  readonly namespace: string;
  readonly expertise: string;
  readonly memory_count: number;
  readonly last_active: string | null;
  readonly metadata: string;
  readonly created_at: string;
}

export function registerAgent(
  db: Database.Database,
  input: { agent_id: string; name: string; namespace?: string; expertise?: string[]; metadata?: Record<string, unknown> },
  defaultNamespace: string,
): AgentProfile {
  const namespace = input.namespace ?? defaultNamespace;
  const now = new Date().toISOString();
  const expertise = JSON.stringify(input.expertise ?? []);
  const metadata = JSON.stringify(input.metadata ?? {});

  // Count memories for this agent
  const countRow = db.prepare(
    'SELECT COUNT(*) as c FROM memories WHERE agent_id = ? AND is_deleted = 0'
  ).get(input.agent_id) as { c: number };

  db.prepare(`
    INSERT INTO agent_profiles (agent_id, name, namespace, expertise, memory_count, last_active, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name = excluded.name,
      expertise = excluded.expertise,
      memory_count = excluded.memory_count,
      last_active = excluded.last_active,
      metadata = excluded.metadata
  `).run(input.agent_id, input.name, namespace, expertise, countRow.c, now, metadata, now);

  return {
    agent_id: input.agent_id,
    name: input.name,
    namespace,
    expertise,
    memory_count: countRow.c,
    last_active: now,
    metadata,
    created_at: now,
  };
}

export function findExpert(
  db: Database.Database,
  query: string,
  namespace: string,
  limit: number = 5,
): readonly AgentProfile[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) return [];

  const agents = db.prepare(
    'SELECT * FROM agent_profiles WHERE namespace = ? ORDER BY memory_count DESC'
  ).all(namespace) as AgentProfile[];

  // Score agents by expertise overlap with query keywords
  const scored = agents.map(agent => {
    const expertiseArr: string[] = JSON.parse(agent.expertise);
    const expertiseLower = expertiseArr.map(e => e.toLowerCase());
    let score = 0;
    for (const kw of keywords) {
      for (const exp of expertiseLower) {
        if (exp.includes(kw) || kw.includes(exp)) score += 1;
      }
    }
    // Boost by memory count (logarithmic)
    score += Math.log(1 + agent.memory_count) * 0.1;
    return { agent, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.agent);
}

export function agentConflicts(
  db: Database.Database,
  namespace: string,
  topic?: string,
): Array<{ agent1: string; agent2: string; memory1: string; memory2: string; topic: string }> {
  // Find memories from different agents on similar topics
  let query = `
    SELECT m1.agent_id as agent1, m2.agent_id as agent2,
           m1.content as memory1, m2.content as memory2,
           m1.category as topic
    FROM memories m1
    JOIN memories m2 ON m1.id < m2.id
      AND m1.agent_id IS NOT NULL AND m2.agent_id IS NOT NULL
      AND m1.agent_id != m2.agent_id
      AND m1.namespace = m2.namespace
      AND m1.category = m2.category
      AND m1.is_deleted = 0 AND m2.is_deleted = 0
    WHERE m1.namespace = ?
  `;
  const params: unknown[] = [namespace];

  if (topic) {
    query += ' AND (m1.content LIKE ? OR m2.content LIKE ?)';
    params.push(`%${topic}%`, `%${topic}%`);
  }

  query += ' LIMIT 20';

  return db.prepare(query).all(...params) as Array<{
    agent1: string; agent2: string; memory1: string; memory2: string; topic: string;
  }>;
}
