import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { registerAgent, findExpert } from '../../src/tools/agent.js';

describe('multi-agent', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('registers an agent', () => {
    const agent = registerAgent(ctx.db, {
      agent_id: 'claude-1', name: 'Claude Code',
      expertise: ['typescript', 'react', 'testing'],
    }, 'default');
    expect(agent.agent_id).toBe('claude-1');
    expect(agent.name).toBe('Claude Code');
  });

  it('upserts on duplicate agent_id', () => {
    registerAgent(ctx.db, { agent_id: 'a1', name: 'V1', expertise: ['python'] }, 'default');
    const updated = registerAgent(ctx.db, { agent_id: 'a1', name: 'V2', expertise: ['rust'] }, 'default');
    expect(updated.name).toBe('V2');

    const count = ctx.db.prepare('SELECT COUNT(*) as c FROM agent_profiles').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('finds experts by query', () => {
    registerAgent(ctx.db, { agent_id: 'a1', name: 'Frontend Dev', expertise: ['react', 'typescript', 'css'] }, 'default');
    registerAgent(ctx.db, { agent_id: 'a2', name: 'Backend Dev', expertise: ['python', 'fastapi', 'postgres'] }, 'default');

    const experts = findExpert(ctx.db, 'react typescript component', 'default');
    expect(experts).toHaveLength(1);
    expect(experts[0]!.name).toBe('Frontend Dev');
  });

  it('returns empty when no expert matches', () => {
    registerAgent(ctx.db, { agent_id: 'a1', name: 'Dev', expertise: ['go'] }, 'default');
    const experts = findExpert(ctx.db, 'quantum physics', 'default');
    expect(experts).toHaveLength(0);
  });
});
