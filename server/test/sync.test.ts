// End-to-end sync: real WebSocket clients against the real server and Redis.
// Skipped when Redis is not reachable (start it with `docker compose up -d`).

import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { startServer } from '../src/index';
import { closeRedis, redis } from '../src/redis';

const hasRedis = await redis.ping().then(
  () => true,
  () => false,
);
if (!hasRedis) await closeRedis();

let server: Server;
let base: string; // http://127.0.0.1:<port>
const cleanups: Array<() => void> = [];

function connect(roomId: string, httpBase = base) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(httpBase.replace('http', 'ws') + '/ws', roomId, doc, {
    WebSocketPolyfill: WebSocket as never,
    // WHY: in one Node process the library would also sync through an
    // in-memory BroadcastChannel and bypass the server we want to test.
    disableBc: true,
  });
  cleanups.push(() => provider.destroy());
  return { doc, provider, text: doc.getText('code') };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function api(path: string, init: RequestInit = {}, httpBase = base) {
  const res = await fetch(httpBase + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  return { status: res.status, body: await res.json() };
}

describe.skipIf(!hasRedis)('sync server', () => {
  beforeAll(async () => {
    server = await startServer(0); // 0 = any free port
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    cleanups.forEach((fn) => fn());
    server.close();
    await closeRedis();
  });

  it('rejects WebSocket connections to rooms that do not exist', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/aaaaaaaaaa');
    const outcome = await new Promise((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('rejected'));
    });
    expect(outcome).toBe('rejected');
  });

  it('syncs edits between two clients and converges on concurrent typing', async () => {
    const { body: room } = await api('/api/rooms', { method: 'POST' });
    const a = connect(room.roomId);
    const b = connect(room.roomId);
    await waitFor(() => a.provider.synced && b.provider.synced, 'initial sync');

    a.text.insert(0, 'hello');
    await waitFor(() => b.text.toString() === 'hello', 'A -> B');

    // Both type at the same moment, at the same position.
    a.text.insert(5, ' from A');
    b.text.insert(5, ' from B');
    await waitFor(
      () => a.text.toString() === b.text.toString() && a.text.length === 'hello from A from B'.length,
      'convergence',
    );
    expect(a.text.toString()).toMatch(/^hello( from A from B| from B from A)$/);
  });

  it('shares presence (awareness) and removes it on disconnect', async () => {
    const { body: room } = await api('/api/rooms', { method: 'POST' });
    const a = connect(room.roomId);
    const b = connect(room.roomId);
    a.provider.awareness.setLocalStateField('user', { name: 'Asha' });
    const names = () =>
      [...b.provider.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean);
    await waitFor(() => names().includes('Asha'), 'presence to arrive');
    a.provider.destroy();
    await waitFor(() => !names().includes('Asha'), 'presence to be removed');
  });

  it('persists to Redis: a late joiner gets the document after everyone left', async () => {
    const { body: room } = await api('/api/rooms', { method: 'POST' });
    const a = connect(room.roomId);
    await waitFor(() => a.provider.synced, 'sync');
    a.text.insert(0, 'saved text');
    // Give the update time to reach the server before disconnecting.
    await new Promise((r) => setTimeout(r, 200));
    a.provider.destroy();
    const health = async () => (await api('/api/health')).body.loadedRooms as number;
    // The room is unloaded from server memory once it is empty.
    let loaded = await health();
    for (let i = 0; i < 100 && loaded > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      loaded = await health();
    }

    const late = connect(room.roomId);
    await waitFor(() => late.text.toString() === 'saved text', 'reload from Redis');
  });

  it('records every keystroke with a timestamp, and the log replays to the same text', async () => {
    const { body: room } = await api('/api/rooms', { method: 'POST' });
    const a = connect(room.roomId);
    await waitFor(() => a.provider.synced, 'sync');
    const typed = 'x = 42';
    for (const ch of typed) a.text.insert(a.text.length, ch);

    let log: Array<{ t: number; u: string }> = [];
    for (let i = 0; i < 100 && log.length < typed.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      log = (await api(`/api/rooms/${room.roomId}/recording`)).body;
    }
    expect(log.length).toBe(typed.length); // one entry per keystroke

    const replay = new Y.Doc();
    const states = log.map((entry) => {
      Y.applyUpdate(replay, Buffer.from(entry.u, 'base64'));
      return replay.getText('code').toString();
    });
    expect(states).toEqual(['x', 'x ', 'x =', 'x = ', 'x = 4', 'x = 42']);
    expect(log.every((entry, i) => i === 0 || entry.t >= log[i - 1].t)).toBe(true);
  });

  it('keeps interviewer notes private and question hints out of the shared document', async () => {
    const { body: room } = await api('/api/rooms', { method: 'POST' });
    const path = `/api/rooms/${room.roomId}`;
    const key = { 'x-interviewer-key': room.interviewerKey };

    expect((await api(`${path}/interview`)).status).toBe(403);
    expect((await api(`${path}/interview`, { headers: { 'x-interviewer-key': 'wrong' } })).status).toBe(403);
    expect((await api(`${path}/questions`)).status).toBe(403);

    const body = JSON.stringify({ notes: 'Strong on hash maps', rating: 4 });
    expect((await api(`${path}/interview`, { method: 'PUT', body, headers: key })).status).toBe(200);
    expect((await api(`${path}/interview`, { headers: key })).body).toEqual({
      notes: 'Strong on hash maps',
      rating: 4,
    });

    const candidate = connect(room.roomId);
    await waitFor(() => candidate.provider.synced, 'sync');
    const set = await api(`${path}/question`, {
      method: 'POST',
      body: JSON.stringify({ questionId: 'two-sum' }),
      headers: key,
    });
    expect(set.status).toBe(200);
    const state = candidate.doc.getMap('state');
    await waitFor(() => state.has('question'), 'question to reach the candidate');
    const question = state.get('question') as Record<string, unknown>;
    expect(question.title).toBe('Two Sum');
    expect(question).not.toHaveProperty('hints');
    // Nothing private is anywhere in the candidate's copy of the document.
    expect(JSON.stringify(candidate.doc.toJSON())).not.toContain('Strong on hash maps');
  });

  it('runs the room code in the sandbox and shares the output through the document', async () => {
    const { body: room } = await api('/api/rooms', { method: 'POST' });
    const a = connect(room.roomId);
    const b = connect(room.roomId);
    await waitFor(() => a.provider.synced && b.provider.synced, 'sync');
    a.doc.getMap('state').set('language', 'python');
    a.text.insert(0, 'print("from the sandbox")');
    await new Promise((r) => setTimeout(r, 200));

    const run = await api(`/api/rooms/${room.roomId}/run`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Asha' }),
    });
    expect(run.body).toMatchObject({ status: 'ok', stdout: 'from the sandbox\n' });
    const seenByB = () => b.doc.getMap('state').get('run') as Record<string, unknown> | undefined;
    await waitFor(() => seenByB()?.status === 'ok', 'output to reach B');
    expect(seenByB()).toMatchObject({ stdout: 'from the sandbox\n', by: 'Asha', language: 'python' });
  });

  describe('two server processes (Redis pub/sub)', () => {
    let child: ChildProcess;
    const otherBase = 'http://127.0.0.1:4191';

    beforeAll(async () => {
      // A second, completely separate server process on another port.
      child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        env: { ...process.env, PORT: '4191' },
        stdio: 'ignore',
      });
      for (let i = 0; i < 200; i++) {
        if (await fetch(otherBase + '/api/health').then((r) => r.ok, () => false)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('second server did not start');
    });

    afterAll(() => {
      child?.kill();
    });

    it('clients on different servers see each other and each other\'s edits', async () => {
      const { body: room } = await api('/api/rooms', { method: 'POST' });
      const a = connect(room.roomId, base);
      const b = connect(room.roomId, otherBase);
      await waitFor(() => a.provider.synced && b.provider.synced, 'sync');

      a.text.insert(0, 'typed on server 1');
      await waitFor(() => b.text.toString() === 'typed on server 1', 'server 1 -> server 2');
      b.text.insert(0, '>> ');
      await waitFor(() => a.text.toString() === '>> typed on server 1', 'server 2 -> server 1');

      a.provider.awareness.setLocalStateField('user', { name: 'Asha' });
      await waitFor(
        () => [...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Asha'),
        'presence across servers',
      );
    });
  });
});
