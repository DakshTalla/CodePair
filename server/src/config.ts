// All tunable settings in one place, each overridable by an environment variable.

export const PORT = Number(process.env.PORT ?? 4100);
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

// Rooms (and their recordings) are deleted by Redis after a week of no edits.
export const ROOM_TTL_SECONDS = 7 * 24 * 3600;

// Limits applied to every sandboxed run (see sandbox.ts for how).
export const SANDBOX = {
  image: process.env.SANDBOX_IMAGE ?? 'codepair-sandbox',
  timeoutMs: 10_000, // wall-clock time, includes compiling C++
  memory: '256m',
  cpus: '1',
  pidsLimit: 64, // stops fork bombs
  maxOutputBytes: 64 * 1024,
  maxCodeBytes: 64 * 1024,
  maxConcurrent: 4, // across the whole server
};
