// Proof, rather than a promise.
//
// "Your contract never leaves this laptop" is the entire reason this project
// exists, and it is the one claim a reader cannot check by looking at the UI.
// So this runs a full review with every outbound socket and every DNS lookup
// instrumented, and fails if anything addresses a host that is not loopback.
//
// Run with: npm run airgap

import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const LOOPBACK = /^(127(\.\d+){3}|::1|localhost)$/i;
const connections = [];
const lookups = [];

/**
 * Record an outbound attempt. Nothing is judged here.
 *
 * The verdict is deliberately deferred to the end of the run, because the
 * target is not reliably known at connect() time — undici fills the address in
 * afterwards — so an entry is corrected in place once the socket is up and
 * only then compared against loopback. Judging at record time meant either
 * trusting a default (which would pass an escape we could not see) or flagging
 * every connection before the correction arrived.
 */
function record(kind, host, port) {
  const entry = { kind, host: String(host), port };
  connections.push(entry);
  return entry;
}

// Every TCP connection in Node, including the one fetch() makes, goes through
// Socket.prototype.connect.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  // Defaulting an unknown host to 127.0.0.1 is the wrong default for a check
  // whose purpose is to catch an escape: an outbound connection whose target
  // we could not read would have been recorded as loopback and passed.
  const entry = record('tcp', opts.host ?? opts.path ?? 'unknown', opts.port);
  // The requested options do not always carry the port (undici fills it in
  // later), so the authoritative endpoint is read off the live socket.
  this.once('connect', () => {
    if (this.remoteAddress) entry.host = this.remoteAddress.replace(/^::ffff:/, '');
    if (this.remotePort) entry.port = this.remotePort;
  });
  return realConnect.apply(this, args);
};

const realTlsConnect = tls.connect;
tls.connect = function patched(...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  record('tls', opts.host ?? 'unknown', opts.port);
  return realTlsConnect.apply(this, args);
};

// A DNS lookup for anything is itself a leak: it tells a resolver you are here.
const realLookup = dns.lookup;
dns.lookup = function patched(hostname, ...rest) {
  lookups.push(String(hostname));
  return realLookup.call(dns, hostname, ...rest);
};
dns.promises.lookup = ((real) => function patched(hostname, ...rest) {
  lookups.push(String(hostname));
  return real.call(dns.promises, hostname, ...rest);
})(dns.promises.lookup);

// Imported after the patches are in place, so nothing escapes before we look.
const { review } = await import('./review.js');
const { health } = await import('./gemma.js');

const contract = await readFile(join(root, 'data', 'sample-contract.txt'), 'utf8');

const h = await health();
if (!h.up) {
  console.log(`Model not running (${h.reason}). Start it with: ollama serve`);
  process.exit(2);
}

console.log('Reviewing the sample contract with all sockets instrumented…\n');
const result = await review(contract, { limit: 6 });

console.log(`Clauses read: ${result.stats.read}, discarded: ${result.stats.unverified + result.stats.unread}`);
console.log(`\nOutbound connections observed: ${connections.length}`);
const tally = new Map();
for (const c of connections) {
  const key = `${c.kind} ${c.host}:${c.port}`;
  tally.set(key, (tally.get(key) || 0) + 1);
}
for (const [key, n] of tally) console.log(`  ${n.toString().padStart(3)} x  ${key}`);

console.log(`\nDNS lookups observed: ${lookups.length}`);
for (const l of new Set(lookups)) console.log(`        ${l}`);

// Judged now that every socket has had its chance to report its real address.
const violations = [
  ...connections.filter((c) => !LOOPBACK.test(c.host)),
  ...[...new Set(lookups)].filter((h) => !LOOPBACK.test(h)).map((h) => ({ kind: 'dns', host: h })),
];

if (violations.length) {
  console.log(`\nFAIL. ${violations.length} connection(s) left this machine:`);
  for (const v of violations) console.log(`  ${v.kind} ${v.host}${v.port ? `:${v.port}` : ''}`);
  process.exit(1);
}

console.log('\nPASS. Every connection was to loopback. The contract never left this machine.');
