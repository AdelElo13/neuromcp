/**
 * host-guard.ts — DNS-rebinding defense shared by the daemon and the legacy
 * dual-mode HTTP transport.
 *
 * Binding to loopback is NOT sufficient: a malicious web page can DNS-rebind
 * `attacker.com` to `127.0.0.1` and then issue same-origin requests to the
 * local server. From the browser's perspective the page is still talking to
 * `attacker.com`, so the same-origin policy does not protect the user's
 * memory. The server must therefore reject any request whose Host header is
 * not an expected loopback host (or an explicitly opted-in extra host).
 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '[::1]',
  'localhost',
]);

/**
 * Returns true when `rawHost` (the value of the HTTP Host header, possibly
 * including a :port suffix) is an allowed loopback host or in `extraAllowed`.
 * Malformed Host headers (unterminated IPv6 bracket, non-numeric port) are
 * rejected so a downstream `new URL(...)` cannot throw on hostile input.
 */
export function isAllowedHost(
  rawHost: string | undefined,
  extraAllowed: ReadonlySet<string> = new Set(),
): boolean {
  if (rawHost === undefined || rawHost === '') return false;
  const lower = rawHost.toLowerCase();
  let host: string;
  let portPart = '';
  if (lower.startsWith('[')) {
    const closing = lower.indexOf(']');
    if (closing === -1) return false; // unterminated bracket → bogus
    host = lower.slice(0, closing + 1);
    portPart = lower.slice(closing + 1); // either '' or ':<port>'
  } else {
    const colon = lower.indexOf(':');
    if (colon === -1) {
      host = lower;
    } else {
      host = lower.slice(0, colon);
      portPart = lower.slice(colon);
    }
  }
  if (portPart.length > 0) {
    if (portPart[0] !== ':') return false;
    const port = portPart.slice(1);
    if (port.length === 0 || !/^\d{1,5}$/.test(port)) return false;
    const portNum = Number(port);
    if (portNum < 1 || portNum > 65535) return false;
  }
  return ALLOWED_HOSTS.has(host) || extraAllowed.has(host);
}
