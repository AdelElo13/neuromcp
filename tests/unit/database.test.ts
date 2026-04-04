import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, rmSync } from 'node:fs';
import { openDatabase, getDatabase, closeDatabase } from '../../src/storage/database.js';

function tmpDbPath(): string {
  return join(tmpdir(), `neuromcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const cleanupPaths: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const p of cleanupPaths) {
    try {
      if (existsSync(p)) unlinkSync(p);
      const walPath = `${p}-wal`;
      if (existsSync(walPath)) unlinkSync(walPath);
      const shmPath = `${p}-shm`;
      if (existsSync(shmPath)) unlinkSync(shmPath);
    } catch {
      // ignore cleanup errors
    }
  }
  cleanupPaths.length = 0;
});

describe('openDatabase', () => {
  it('creates the database file', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    openDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('sets WAL journal mode', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });

  it('sets synchronous to NORMAL', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    const result = db.pragma('synchronous') as Array<{ synchronous: number }>;
    expect(result[0].synchronous).toBe(1); // NORMAL = 1
  });

  it('enables foreign keys', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0].foreign_keys).toBe(1);
  });

  it('sets busy_timeout to 5000', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    const result = db.pragma('busy_timeout') as Array<{ timeout: number }>;
    expect(result[0].timeout).toBe(5000);
  });

  it('sets cache_size', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    const result = db.pragma('cache_size') as Array<{ cache_size: number }>;
    expect(result[0].cache_size).toBe(-64000);
  });

  it('creates parent directories', () => {
    const nested = join(tmpdir(), `neuromcp-nested-${Date.now()}`, 'sub', 'dir', 'test.db');
    cleanupPaths.push(nested);
    openDatabase(nested);
    expect(existsSync(nested)).toBe(true);
    // cleanup nested dirs
    try {
      rmSync(join(tmpdir(), `neuromcp-nested-${Date.now()}`), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});

describe('getDatabase', () => {
  it('throws when database is not initialized', () => {
    expect(() => getDatabase()).toThrow('Database not initialized');
  });

  it('returns the database after openDatabase is called', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    expect(getDatabase()).toBe(db);
  });
});

describe('closeDatabase', () => {
  it('closes the database and resets state', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    openDatabase(dbPath);
    closeDatabase();
    expect(() => getDatabase()).toThrow('Database not initialized');
  });

  it('is safe to call multiple times', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    openDatabase(dbPath);
    closeDatabase();
    closeDatabase(); // should not throw
  });
});
