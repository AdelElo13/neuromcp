import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';

describe('Logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('writes to stderr, never stdout', () => {
    const logger = createLogger({ level: 'debug', format: 'text' });
    logger.info('test', 'hello');

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('respects level filtering — debug suppressed at info level', () => {
    const logger = createLogger({ level: 'info', format: 'text' });
    logger.debug('test', 'should not appear');

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('respects level filtering — warn passes at info level', () => {
    const logger = createLogger({ level: 'info', format: 'text' });
    logger.warn('test', 'should appear');

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('respects level filtering — error level suppresses warn', () => {
    const logger = createLogger({ level: 'error', format: 'text' });
    logger.warn('test', 'suppressed');
    logger.info('test', 'suppressed');
    logger.debug('test', 'suppressed');

    expect(stderrSpy).not.toHaveBeenCalled();

    logger.error('test', 'visible');
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  describe('JSON format', () => {
    it('produces parseable JSON with all required fields', () => {
      const logger = createLogger({ level: 'debug', format: 'json' });
      logger.info('storage', 'record saved', { count: 42 });

      const raw = stderrSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(raw.trim());

      expect(parsed.level).toBe('info');
      expect(parsed.component).toBe('storage');
      expect(parsed.message).toBe('record saved');
      expect(parsed.count).toBe(42);
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('includes operation_id when provided', () => {
      const logger = createLogger({ level: 'debug', format: 'json' });
      logger.info('embedding', 'computed', undefined, 'op-abc-123');

      const raw = stderrSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(raw.trim());

      expect(parsed.operation_id).toBe('op-abc-123');
    });

    it('omits operation_id when not provided', () => {
      const logger = createLogger({ level: 'debug', format: 'json' });
      logger.info('embedding', 'computed');

      const raw = stderrSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(raw.trim());

      expect(parsed).not.toHaveProperty('operation_id');
    });

    it('includes duration_ms from metadata', () => {
      const logger = createLogger({ level: 'debug', format: 'json' });
      logger.info('consolidation', 'finished', { duration_ms: 150 });

      const raw = stderrSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(raw.trim());

      expect(parsed.duration_ms).toBe(150);
    });
  });

  describe('text format', () => {
    it('includes component tag in brackets', () => {
      const logger = createLogger({ level: 'debug', format: 'text' });
      logger.info('storage', 'hello world');

      const raw = stderrSpy.mock.calls[0]![0] as string;
      expect(raw).toContain('[storage]');
      expect(raw).toContain('INFO');
      expect(raw).toContain('hello world');
    });

    it('includes operation_id when provided', () => {
      const logger = createLogger({ level: 'debug', format: 'text' });
      logger.info('storage', 'hello', undefined, 'op-xyz');

      const raw = stderrSpy.mock.calls[0]![0] as string;
      expect(raw).toContain('op=op-xyz');
    });
  });
});
