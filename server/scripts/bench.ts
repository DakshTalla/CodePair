// Measures the numbers quoted in the README and resume bullets.
//
//   npm run bench        (needs Redis and the sandbox image, like the tests)
//
// It starts a real server on a free port, connects real WebSocket clients and
// writes the results to docs/benchmarks.json.

import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { cpus } from 'node:os';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { startServer } from '../src/index';
import { closeRedis } from '../src/redis';
import { runCode, type Language } from '../src/sandbox';

const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const providers: WebsocketProvider[] = [];

async function newRoom(): Promise<string> {
  const res = await fetch(base + '/api/rooms', { method: 'POST' });
  return ((await res.json()) as { roomId: string }).roomId;
}

async function connect(roomId: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(base.replace('http', 'ws') + '/ws', roomId, doc, {
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  });
  providers.push(provider);
  await new Promise<void>((resolve) => provider.once('sync', () => resolve()));
  return { doc, provider, text: doc.getText('code') };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const round = (n: number, digits = 2) => Number(n.toFixed(digits));

// 1. Keystroke latency: A types one character, how long until B has it?
async function keystrokeLatency(samples: number) {
  const roomId = await newRoom();
  const a = await connect(roomId);
  const b = await connect(roomId);
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const arrived = new Promise<void>((resolve) => b.doc.once('update', () => resolve()));
    const start = performance.now();
    a.text.insert(a.text.length, 'x');
    await arrived;
    times.push(performance.now() - start);
  }
  times.sort((x, y) => x - y);
  return { samples, p50Ms: round(percentile(times, 0.5)), p95Ms: round(percentile(times, 0.95)), p99Ms: round(percentile(times, 0.99)) };
}

// 2. Convergence under load: several clients type at random positions at the
//    same time through the server. All must end with identical text.
async function concurrentConvergence(clients: number, editsEach: number) {
  const roomId = await newRoom();
  const peers = await Promise.all(Array.from({ length: clients }, () => connect(roomId)));
  const start = performance.now();
  await Promise.all(
    peers.map(async (peer, p) => {
      for (let i = 0; i < editsEach; i++) {
        const index = Math.floor(Math.random() * (peer.text.length + 1));
        if (peer.text.length > 0 && Math.random() < 0.25) peer.text.delete(Math.min(index, peer.text.length - 1), 1);
        else peer.text.insert(index, String.fromCharCode(97 + p));
        if (i % 20 === 0) await sleep(0); // let network messages interleave with typing
      }
    }),
  );
  const same = () => peers.every((peer) => peer.text.toString() === peers[0].text.toString());
  const sent = () => peers.every((peer) => Y.encodeStateVector(peer.doc).join() === Y.encodeStateVector(peers[0].doc).join());
  while (!(same() && sent())) await sleep(5);
  const convergedMs = performance.now() - start;

  // Recording size and reload time for the same room.
  await sleep(300);
  const log = (await (await fetch(`${base}/api/rooms/${roomId}/recording`)).json()) as Array<{ u: string }>;
  const bytes = log.reduce((sum, entry) => sum + Buffer.from(entry.u, 'base64').length, 0);
  peers.forEach((peer) => peer.provider.destroy());
  await sleep(300); // room unloads from memory
  const reloadStart = performance.now();
  const late = await connect(roomId);
  const reloadMs = performance.now() - reloadStart;

  return {
    clients,
    totalEdits: clients * editsEach,
    converged: late.text.toString() === peers[0].text.toString() && same(),
    convergedMs: round(convergedMs, 0),
    recordedUpdates: log.length,
    avgBytesPerUpdate: round(bytes / log.length, 1),
    coldReloadMs: round(reloadMs, 0), // rebuild the document from the Redis log
  };
}

// 3. Sandbox: time for a full run (container start + program + teardown).
async function sandboxTimes(runs: number) {
  const programs: Record<Language, string> = {
    python: 'print("hi")',
    javascript: 'console.log("hi")',
    cpp: '#include <iostream>\nint main() { std::cout << "hi\\n"; }',
  };
  const result: Record<string, { medianMs: number; minMs: number }> = {};
  for (const lang of Object.keys(programs) as Language[]) {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const run = await runCode(lang, programs[lang]);
      if (run.status !== 'ok') throw new Error(`${lang} failed: ${run.stderr}`);
      times.push(run.timeMs);
    }
    times.sort((x, y) => x - y);
    result[lang] = { medianMs: percentile(times, 0.5), minMs: times[0] };
  }
  // How quickly is an infinite loop stopped after its time limit?
  const loop = await runCode('python', 'while True:\n    pass', { timeoutMs: 2000 });
  return { runs, ...result, infiniteLoop: { limitMs: 2000, status: loop.status, returnedAfterMs: loop.timeMs } };
}

console.log('Measuring keystroke latency...');
const latency = await keystrokeLatency(1000);
console.log('Measuring convergence under concurrent edits...');
const convergence = await concurrentConvergence(5, 400);
console.log('Measuring sandbox run times...');
const sandbox = await sandboxTimes(7);

const results = {
  measuredAt: new Date().toISOString().slice(0, 10),
  machine: `${cpus()[0].model.trim()}, ${cpus().length} threads, Node ${process.version}, Docker Desktop (WSL2)`,
  note: 'Server, Redis and clients all on one laptop (localhost), so latency excludes real network delay.',
  latency,
  convergence,
  sandbox,
};
console.log(JSON.stringify(results, null, 2));
writeFileSync(new URL('../../docs/benchmarks.json', import.meta.url), JSON.stringify(results, null, 2) + '\n', 'utf-8');

providers.forEach((provider) => provider.destroy());
server.close();
await closeRedis();
process.exit(0);
