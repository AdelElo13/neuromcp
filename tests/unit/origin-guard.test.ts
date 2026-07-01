import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from '../../src/transport/host-guard.js';

/**
 * Regression: the /mcp Streamable HTTP endpoint used the Origin header
 * only to decide which Access-Control-Allow-Origin value to echo — it
 * never REJECTED a request with a hostile Origin. The MCP spec
 * (Streamable HTTP, 2025-03-26) requires servers to validate Origin as a
 * defense-in-depth layer against DNS-rebinding-style attacks that slip
 * past the Host allowlist.
 *
 * Policy implemented by `isAllowedOrigin`:
 *  - Absent/empty Origin → allowed (curl and native MCP clients send none;
 *    rebinding attacks originate in browsers, which always send Origin).
 *  - Loopback origins (127.0.0.1 / ::1 / localhost, any port/scheme) → allowed.
 *  - Anything else — foreign hosts, the literal "null" origin, malformed
 *    values — → rejected.
 */
describe('isAllowedOrigin', () => {
  it('allows an absent Origin header (non-browser clients)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('allows an empty Origin header', () => {
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('allows loopback IPv4 origins on any port', () => {
    expect(isAllowedOrigin('http://127.0.0.1:6274')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1')).toBe(true);
  });

  it('allows localhost origins', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('https://localhost')).toBe(true);
  });

  it('allows loopback IPv6 origins', () => {
    expect(isAllowedOrigin('http://[::1]:8080')).toBe(true);
  });

  it('rejects foreign origins', () => {
    expect(isAllowedOrigin('http://attacker.com')).toBe(false);
    expect(isAllowedOrigin('https://evil.example:443')).toBe(false);
  });

  it('rejects a rebinding-style origin that merely CONTAINS localhost', () => {
    expect(isAllowedOrigin('http://localhost.attacker.com')).toBe(false);
  });

  it('rejects the literal "null" origin (sandboxed iframe / file://)', () => {
    expect(isAllowedOrigin('null')).toBe(false);
  });

  it('rejects malformed origins', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
  });

  it('uses the first value when the header arrives as an array', () => {
    expect(isAllowedOrigin(['http://evil.com', 'http://127.0.0.1'])).toBe(false);
    expect(isAllowedOrigin(['http://127.0.0.1:1234'])).toBe(true);
  });

  it('honours extraAllowed hosts (parity with isAllowedHost opt-in)', () => {
    const extra = new Set(['myhost.internal']);
    expect(isAllowedOrigin('http://myhost.internal:3200', extra)).toBe(true);
    expect(isAllowedOrigin('http://myhost.internal:3200')).toBe(false);
  });
});
