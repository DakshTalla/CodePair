// Real-time sync: one Yjs document per room, kept in memory while anyone is
// connected, with every change appended to Redis.
//
// The shared document has three parts (the browser uses the same names):
//   doc.getText('code')   the editor contents
//   doc.getMap('state')   language, current question, last run result
//   doc.getArray('chat')  chat messages
//
// How a keystroke travels:
//   browser A --ws--> this server: apply to the in-memory doc
//                       |--> every other browser in the room (WebSocket)
//                       |--> Redis list   (persistence + the replay recording)
//                       '--> Redis pub/sub (other server processes, if any)
//
// WHY this is safe without locks: Yjs updates are commutative and idempotent.
// Applying them in a different order, or applying one twice, gives the same
// document. So servers and browsers can simply forward whatever they receive.

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { ROOM_TTL_SECONDS } from './config';
import { CHANNEL_PREFIX, logKey, redis, roomKey, sub } from './redis';

// The first byte of every WebSocket message says what it is. These numbers are
// fixed by the y-websocket client library.
const MSG_SYNC = 0; // document data
const MSG_AWARENESS = 1; // presence: names, colours, cursors

// "origin" tags tell an update listener where a change came from.
const FROM_REDIS = Symbol('from-redis'); // do not persist or publish again
const INSTANCE_ID = randomUUID(); // lets a server ignore its own pub/sub messages

export interface Room {
  id: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  // Each socket, and the awareness client ids it introduced. Needed to remove
  // a user's cursor when their socket closes.
  conns: Map<WebSocket, Set<number>>;
  // Number of HTTP handlers currently using the room (keeps it loaded).
  pins: number;
}

// WHY a map of promises: if two sockets join an unloaded room at the same
// moment they must share one load, not create two separate documents.
const rooms = new Map<string, Promise<Room>>();

export interface LogEntry {
  t: number; // server time in ms when the update arrived
  u: string; // base64 Yjs update
}

export async function readLog(roomId: string): Promise<LogEntry[]> {
  const raw = await redis.lrange(logKey(roomId), 0, -1);
  return raw.map((line: string) => {
    const bar = line.indexOf('|');
    return { t: Number(line.slice(0, bar)), u: line.slice(bar + 1) };
  });
}

export function getRoom(roomId: string): Promise<Room> {
  let room = rooms.get(roomId);
  if (!room) {
    room = loadRoom(roomId);
    rooms.set(roomId, room);
    room.catch(() => rooms.delete(roomId)); // a failed load must be retryable
  }
  return room;
}

async function loadRoom(roomId: string): Promise<Room> {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server itself is not a participant
  const room: Room = { id: roomId, doc, awareness, conns: new Map(), pins: 0 };

  // Rebuild the document by replaying every stored update.
  for (const entry of await readLog(roomId)) {
    Y.applyUpdate(doc, Buffer.from(entry.u, 'base64'), FROM_REDIS);
  }

  // Listeners are attached AFTER the replay so loading does not re-save.
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder), origin);
    if (origin !== FROM_REDIS) {
      const b64 = Buffer.from(update).toString('base64');
      // Refreshing the TTL on every write keeps active rooms alive.
      redis
        .multi()
        .rpush(logKey(roomId), `${Date.now()}|${b64}`)
        .expire(logKey(roomId), ROOM_TTL_SECONDS)
        .expire(roomKey(roomId), ROOM_TTL_SECONDS)
        .exec()
        .catch((err: Error) => console.error('[sync] persist failed:', err.message));
      publish(roomId, 'update', b64);
    }
  });

  awareness.on(
    'update',
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const ids = room.conns.get(origin as WebSocket);
      if (ids) {
        changes.added.forEach((id) => ids.add(id));
        changes.removed.forEach((id) => ids.delete(id));
      }
      const changed = [...changes.added, ...changes.updated, ...changes.removed];
      const payload = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
      // Sent to everyone including the sender: the echo doubles as a heartbeat
      // that stops the client library from assuming the connection is dead.
      broadcast(room, awarenessFrame(payload), null);
      if (origin !== FROM_REDIS) publish(roomId, 'awareness', Buffer.from(payload).toString('base64'));
    },
  );

  return room;
}

function awarenessFrame(payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

function broadcast(room: Room, message: Uint8Array, except: unknown): void {
  for (const ws of room.conns.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(message);
  }
}

// ---- Redis pub/sub: lets several server processes serve the same room ----

function publish(roomId: string, kind: 'update' | 'awareness', data: string): void {
  redis
    .publish(CHANNEL_PREFIX + roomId, JSON.stringify({ from: INSTANCE_ID, kind, data }))
    .catch((err: Error) => console.error('[sync] publish failed:', err.message));
}

export async function startPubSub(): Promise<void> {
  // One pattern subscription covers every room.
  await sub.psubscribe(CHANNEL_PREFIX + '*');
  sub.on('pmessage', (_pattern: string, channel: string, raw: string) => {
    const message = JSON.parse(raw) as { from: string; kind: string; data: string };
    if (message.from === INSTANCE_ID) return; // our own message, already applied
    // Only rooms loaded on this server care. Waiting on the promise means a
    // message that arrives mid-load is applied right after the load finishes.
    rooms.get(channel.slice(CHANNEL_PREFIX.length))?.then((room) => {
      const bytes = Buffer.from(message.data, 'base64');
      if (message.kind === 'update') Y.applyUpdate(room.doc, bytes, FROM_REDIS);
      else awarenessProtocol.applyAwarenessUpdate(room.awareness, bytes, FROM_REDIS);
    });
  });
}

// ---- WebSocket connections ----

export function handleConnection(ws: WebSocket, roomId: string): void {
  const ready = getRoom(roomId).then((room) => {
    room.conns.set(ws, new Set());
    // Sync step 1: "here is what I have, send me what I am missing". The
    // client answers with step 2 and sends its own step 1, so both sides end
    // up with the union of their changes.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    ws.send(encoding.toUint8Array(encoder));
    const present = [...room.awareness.getStates().keys()];
    if (present.length > 0) {
      ws.send(awarenessFrame(awarenessProtocol.encodeAwarenessUpdate(room.awareness, present)));
    }
    return room;
  });

  // Messages can arrive before the room has loaded. Chaining on the promise
  // keeps them in order and delays them until the document exists.
  ws.on('message', (data: Buffer) => {
    ready
      .then((room) => onMessage(room, ws, new Uint8Array(data)))
      .catch((err: Error) => {
        console.error('[sync] bad message:', err.message);
        ws.close();
      });
  });

  ws.on('close', () => {
    ready
      .then((room) => {
        const ids = room.conns.get(ws) ?? new Set<number>();
        room.conns.delete(ws);
        // Tell everyone this user's cursor is gone.
        awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
        unloadIfUnused(room);
      })
      .catch(() => {});
  });
}

function onMessage(room: Room, ws: WebSocket, data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  if (type === MSG_SYNC) {
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MSG_SYNC);
    // Applies the message to the doc with `ws` as the origin (so the update
    // listener does not echo it back to the sender) and writes any reply.
    syncProtocol.readSyncMessage(decoder, reply, room.doc, ws);
    if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
  } else if (type === MSG_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
  }
}

// ---- Use from HTTP handlers (running code, setting the question) ----

// Loads the room if needed and keeps it loaded while `fn` runs.
export async function withRoom<T>(roomId: string, fn: (room: Room) => Promise<T>): Promise<T> {
  const room = await getRoom(roomId);
  room.pins++;
  try {
    return await fn(room);
  } finally {
    room.pins--;
    unloadIfUnused(room);
  }
}

// WHY unload: the document lives in Redis, so an empty room should not keep
// using server memory. The next visitor reloads it from the log.
function unloadIfUnused(room: Room): void {
  if (room.conns.size > 0 || room.pins > 0) return;
  rooms.delete(room.id);
  room.awareness.destroy();
  room.doc.destroy();
}

export function loadedRoomCount(): number {
  return rooms.size;
}
