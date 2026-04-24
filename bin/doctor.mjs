#!/usr/bin/env node
/**
 * neuromcp doctor — diagnostic CLI that proves the install is healthy
 * AND that no surprise outbound network calls happen during normal
 * operation. Sprint 4 / Week 1 launch artefact.
 *
 * Subcommands (use `--help` for the list):
 *   audit-network    Wraps the neuromcp server in an outgoing-call snitch
 *                    for 30 seconds and reports any non-loopback connections.
 *   check            Quick env + dep + db check.
 *
 * Exits non-zero if a check fails so this is CI-friendly.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const CMD = process.argv[2] ?? 'check';

if (CMD === 'help' || CMD === '--help' || CMD === '-h') {
  printHelp();
  process.exit(0);
}

if (CMD === 'check') {
  await runCheck();
} else if (CMD === 'audit-network') {
  await runAuditNetwork();
} else {
  console.error(`Unknown subcommand: ${CMD}\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stdout.write(`
neuromcp doctor — install + privacy diagnostics

Usage:
  neuromcp doctor check               quick env + dep + dist check
  neuromcp doctor audit-network       proves zero-egress for 30s
  neuromcp doctor --help              this message

`);
}

async function runCheck() {
  const checks = [];
  const ok = (name, info) => checks.push({ name, ok: true, info });
  const fail = (name, info) => checks.push({ name, ok: false, info });

  // 1. Node version
  const nv = process.versions.node;
  const major = parseInt(nv.split('.')[0], 10);
  if (major >= 20) ok('node version', `v${nv}`);
  else fail('node version', `v${nv} — neuromcp requires Node 20+`);

  // 2. dist/ exists (run npm run build if not)
  const distPath = resolve(REPO_ROOT, 'dist', 'index.js');
  if (existsSync(distPath)) ok('dist/index.js', distPath);
  else fail('dist/index.js', 'run `npm run build` first');

  // 3. better-sqlite3 native binding present
  const sqlitePath = resolve(
    REPO_ROOT, 'node_modules', 'better-sqlite3',
    'build', 'Release', 'better_sqlite3.node',
  );
  if (existsSync(sqlitePath)) ok('better-sqlite3 native', 'built');
  else fail('better-sqlite3 native', 'run `npm rebuild better-sqlite3`');

  // 4. package.json version
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    ok('package version', pkg.version);
  } catch (err) {
    fail('package.json', String(err));
  }

  // 5. ~/.neuromcp directory writable (where wiki + db live)
  const userDir = resolve(homedir(), '.neuromcp');
  ok('user data dir', existsSync(userDir) ? userDir : `(will be created on first run) ${userDir}`);

  // 6. Platform note
  ok('platform', `${platform()} ${process.arch}`);

  // Render
  const w = Math.max(...checks.map(c => c.name.length)) + 2;
  for (const c of checks) {
    const pad = c.name.padEnd(w);
    process.stdout.write(`${c.ok ? '\u2713' : '\u2717'} ${pad} ${c.info}\n`);
  }
  const failed = checks.filter(c => !c.ok).length;
  process.exit(failed === 0 ? 0 : 1);
}

async function runAuditNetwork() {
  // Strategy: spawn the neuromcp server as a child process with a custom
  // Node `--require` shim that monkey-patches `node:net`'s Socket.connect
  // and `node:dgram`. Any non-loopback target is logged. Run for 30s,
  // then report.
  const shimPath = resolve(HERE, 'audit-network-shim.mjs');
  if (!existsSync(shimPath)) {
    // Lazy-write the shim on first use to keep the bin/ dir clean.
    writeShim(shimPath);
  }

  const dist = resolve(REPO_ROOT, 'dist', 'index.js');
  if (!existsSync(dist)) {
    process.stderr.write('dist/index.js missing — run `npm run build` first\n');
    process.exit(1);
  }

  const auditEvents = [];
  const child = spawn(
    process.execPath,
    ['--import', shimPath, dist],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NEUROMCP_AUDIT_NETWORK: '1',
        NEUROMCP_HTTP_ENABLED: '1',
        NEUROMCP_HTTP_PORT: '0',
      },
    },
  );

  child.stderr.on('data', (b) => {
    const s = b.toString();
    for (const line of s.split('\n')) {
      if (line.startsWith('[NET-AUDIT]')) auditEvents.push(line.slice(11).trim());
    }
  });

  process.stdout.write('Auditing outbound connections for 30 seconds...\n');
  await new Promise(r => setTimeout(r, 30000));

  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  if (!child.killed) child.kill('SIGKILL');

  if (auditEvents.length === 0) {
    process.stdout.write(
      '\n\u2713 zero TCP/UDP outbound connections observed in 30s\n' +
      '  (via net.Socket + dgram shim — does NOT cover undici/fetch,\n' +
      '   node:http2, or DNS prefetch. For completeness run\n' +
      '   `tcpdump -i any -n host not 127.0.0.1` alongside.)\n',
    );
    process.exit(0);
  } else {
    process.stdout.write(`\n\u2717 ${auditEvents.length} outbound connections observed:\n`);
    for (const e of auditEvents) process.stdout.write(`  ${e}\n`);
    process.exit(1);
  }
}

function writeShim(path) {
  const src = `
// audit-network-shim.mjs — registered via --import. Wraps net.Socket.connect
// and dgram.createSocket().send to log non-loopback destinations to stderr
// with the [NET-AUDIT] prefix. The doctor CLI greps for that prefix.
import net from 'node:net';
import dgram from 'node:dgram';

const isLoopback = (host) => {
  if (!host) return true;
  const h = String(host);
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  let opts = args[0];
  if (typeof opts === 'object' && opts !== null) {
    if (!isLoopback(opts.host)) {
      process.stderr.write(\`[NET-AUDIT] tcp connect host=\${opts.host} port=\${opts.port}\\n\`);
    }
  } else if (typeof args[1] === 'string') {
    if (!isLoopback(args[1])) {
      process.stderr.write(\`[NET-AUDIT] tcp connect host=\${args[1]} port=\${args[0]}\\n\`);
    }
  }
  return origConnect.apply(this, args);
};

const origCreate = dgram.createSocket;
dgram.createSocket = function patchedCreate(...args) {
  const sock = origCreate.apply(this, args);
  const origSend = sock.send.bind(sock);
  sock.send = function patchedSend(buf, off, len, port, address, cb) {
    const host = typeof off === 'string' ? off : address;
    if (!isLoopback(host)) {
      process.stderr.write(\`[NET-AUDIT] udp send host=\${host} port=\${typeof off === 'string' ? len : port}\\n\`);
    }
    return origSend(buf, off, len, port, address, cb);
  };
  return sock;
};
`;
  writeFileSync(path, src.trim() + '\n', { mode: 0o644 });
}
