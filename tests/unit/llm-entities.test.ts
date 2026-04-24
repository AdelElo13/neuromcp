import { describe, it, expect } from 'vitest';
import { parseEntitiesPayload, extractEntitiesViaLLM } from '../../src/graph/llm-entities.js';

describe('parseEntitiesPayload', () => {
  it('parses a clean JSON payload into LLMEntity objects', () => {
    const text = '{"entities":[{"name":"Rachel","type":"person"},{"name":"Yosemite","type":"place"}]}';
    const out = parseEntitiesPayload(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Rachel', type: 'person' });
    expect(out[1]).toEqual({ name: 'Yosemite', type: 'place' });
  });

  it('strips ```json fences before parsing', () => {
    const text = '```json\n{"entities":[{"name":"Apple","type":"org"}]}\n```';
    const out = parseEntitiesPayload(text);
    expect(out).toEqual([{ name: 'Apple', type: 'org' }]);
  });

  it('tolerates leading/trailing prose around the JSON block', () => {
    const text = 'Here are the entities I found:\n{"entities":[{"name":"Berlin","type":"place"}]}\nLet me know if you need more.';
    const out = parseEntitiesPayload(text);
    expect(out).toEqual([{ name: 'Berlin', type: 'place' }]);
  });

  it('coerces unknown type to "name"', () => {
    const text = '{"entities":[{"name":"Bob","type":"hobbit"}]}';
    const out = parseEntitiesPayload(text);
    expect(out).toEqual([{ name: 'Bob', type: 'name' }]);
  });

  it('drops entries without a name or with overly long names', () => {
    const text = JSON.stringify({
      entities: [
        { name: '', type: 'person' },
        { name: 'A'.repeat(200), type: 'person' },
        { name: 'Valid', type: 'person' },
      ],
    });
    const out = parseEntitiesPayload(text);
    expect(out).toEqual([{ name: 'Valid', type: 'person' }]);
  });

  it('returns empty array on garbage input', () => {
    expect(parseEntitiesPayload('totally not json')).toEqual([]);
    expect(parseEntitiesPayload('')).toEqual([]);
    expect(parseEntitiesPayload('{ broken')).toEqual([]);
  });

  it('returns empty when entities key is missing', () => {
    expect(parseEntitiesPayload('{"foo":1}')).toEqual([]);
  });
});

describe('extractEntitiesViaLLM (without claude CLI)', () => {
  it('returns [] when the cli executable does not exist', async () => {
    const out = await extractEntitiesViaLLM('Rachel told me about Yosemite.', {
      cliPath: '/nonexistent/binary-that-does-not-exist',
      timeoutMs: 1000,
    });
    expect(out).toEqual([]);
  });

  it('returns [] for empty input without invoking the CLI', async () => {
    expect(await extractEntitiesViaLLM('')).toEqual([]);
    expect(await extractEntitiesViaLLM('   \n  ')).toEqual([]);
  });

  it('happy path round-trip via stub CLI (Codex Sprint 2.3 Q7)', async () => {
    // Use /bin/sh -c to emit a fixed JSON payload — proves the spawn →
    // stdout → parser pipeline end-to-end without depending on claude.
    // We override cliPath to /bin/sh and pass the JSON via stdin echo trick.
    // Actually simpler: use printf via a tiny helper script.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ent-stub-'));
    const stubPath = path.join(stubDir, 'fake-claude');
    fs.writeFileSync(
      stubPath,
      '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"entities":[{"name":"Rachel","type":"person"},{"name":"Yosemite","type":"place"}]}\'\n',
      { mode: 0o755 },
    );
    try {
      const out = await extractEntitiesViaLLM('hello world', {
        cliPath: stubPath,
        timeoutMs: 5000,
      });
      expect(out).toEqual([
        { name: 'Rachel', type: 'person' },
        { name: 'Yosemite', type: 'place' },
      ]);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
