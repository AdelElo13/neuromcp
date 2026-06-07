import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, '..', '..', 'scripts', 'consolidate-sessions.py');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf-8');

// NOTE: These are structural assertions, not behavioural ones. A full retry
// behaviour test would need an integration harness with a fake `claude` shim
// (tracked in FOUND-DURING-FIX.md as a follow-up). These tests ensure the
// retry primitives are present so a future refactor cannot silently drop them.
describe('consolidate-sessions.py — audit retry loop', () => {
  it('defines a bounded MAX_AUDIT_ATTEMPTS constant', () => {
    // Bounded retry prevents infinite spin on persistent Haiku non-determinism.
    const match = SCRIPT.match(/^MAX_AUDIT_ATTEMPTS\s*=\s*(\d+)/m);
    expect(match, 'expected `MAX_AUDIT_ATTEMPTS = <int>` at module scope').not.toBeNull();
    const value = Number(match![1]);
    expect(value, 'MAX_AUDIT_ATTEMPTS must be > 0 (retries enabled)').toBeGreaterThan(0);
    expect(value, 'MAX_AUDIT_ATTEMPTS must be <= 5 (cost cap)').toBeLessThanOrEqual(5);
  });

  it('escalates the model on retry (RETRY_MODEL != AUDIT_MODEL)', () => {
    // Same model on retry doesn't fix Haiku's count-fact hallucinations.
    // Different tier (sonnet) is the recommended escalation per
    // FOUND-DURING-FIX.md P1.
    const audit = SCRIPT.match(/^AUDIT_MODEL\s*=\s*"([^"]+)"/m);
    const retry = SCRIPT.match(/^RETRY_MODEL\s*=\s*"([^"]+)"/m);
    expect(audit, 'expected `AUDIT_MODEL = "<name>"`').not.toBeNull();
    expect(retry, 'expected `RETRY_MODEL = "<name>"`').not.toBeNull();
    expect(retry![1], 'RETRY_MODEL must differ from AUDIT_MODEL').not.toBe(audit![1]);
  });

  it('wraps summary+audit in a for-loop bounded by MAX_AUDIT_ATTEMPTS', () => {
    // The loop is the actual retry primitive — without it, the constants
    // above are dead variables.
    expect(SCRIPT).toMatch(/for\s+attempt\s+in\s+range\(MAX_AUDIT_ATTEMPTS\s*\+\s*1\)/);
  });

  it('routes exhausted batches to a dedicated review-queue subfolder', () => {
    // Per FOUND-DURING-FIX.md P1 terminal-state design: keep "review-queue/"
    // for transient rejects, "review-queue/exhausted/" for batches that have
    // burned all retries. This keeps health-check.sh able to surface a clear
    // degraded signal.
    expect(SCRIPT).toMatch(/exhausted/);
  });
});
