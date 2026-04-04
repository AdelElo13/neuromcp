import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it('returns defaults when no env vars set', () => {
    delete process.env.NEUROMCP_DB_PATH;
    delete process.env.NEUROMCP_LOG_LEVEL;
    const cfg = loadConfig();
    expect(cfg.dbPath).toContain('.neuromcp');
    expect(cfg.dbPath).toContain('memory.db');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.defaultNamespace).toBe('default');
    expect(cfg.autoConsolidate).toBe(false);
    expect(cfg.dedupThreshold).toBe(0.92);
    expect(cfg.tombstoneTtlDays).toBe(30);
  });

  it('reads env var overrides', () => {
    process.env.NEUROMCP_DB_PATH = '/tmp/test.db';
    process.env.NEUROMCP_LOG_LEVEL = 'debug';
    process.env.NEUROMCP_AUTO_CONSOLIDATE = 'true';
    process.env.NEUROMCP_DEDUP_THRESHOLD = '0.85';
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe('/tmp/test.db');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.autoConsolidate).toBe(true);
    expect(cfg.dedupThreshold).toBe(0.85);
  });

  it('handles invalid numeric values gracefully', () => {
    process.env.NEUROMCP_MAX_DB_SIZE_MB = 'notanumber';
    const cfg = loadConfig();
    expect(cfg.maxDbSizeMb).toBe(500);
  });
});
