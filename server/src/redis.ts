// Redis connections and the key names used across the server.
//
// WHY two connections: a Redis connection that has subscribed to a channel can
// no longer run normal commands, so pub/sub needs its own connection.

import { Redis } from 'ioredis';
import { REDIS_URL } from './config';

// lazyConnect: nothing connects until the first command, so importing this
// file in a unit test that never touches Redis is harmless.
const options = { lazyConnect: true, maxRetriesPerRequest: 2 };

export const redis = new Redis(REDIS_URL, options);
export const sub = new Redis(REDIS_URL, options);

// Without a listener, ioredis prints an "Unhandled error event" stack trace for
// every failed reconnect. One short line is enough.
for (const client of [redis, sub]) {
  client.on('error', (err: Error) => console.error('[redis]', err.message));
}

// Key layout (everything is prefixed so the database can be shared):
//   cp:room:<id>          hash   createdAt, interviewerKey, notes, rating
//   cp:room:<id>:log      list   "<timestamp>|<base64 Yjs update>" in arrival order
//   cp:room:<id>:runlock  string short-lived lock: one code run per room at a time
//   cp:pub:<id>           pub/sub channel that fans updates out to other servers
export const roomKey = (id: string) => `cp:room:${id}`;
export const logKey = (id: string) => `cp:room:${id}:log`;
export const runLockKey = (id: string) => `cp:room:${id}:runlock`;
export const CHANNEL_PREFIX = 'cp:pub:';

export async function closeRedis(): Promise<void> {
  redis.disconnect();
  sub.disconnect();
}
