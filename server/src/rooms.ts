// Room metadata and the interviewer's private data, stored in a Redis hash.
//
// A room has two secrets:
//   - the room id, which is the shareable link (anyone with it can join), and
//   - the interviewer key, returned only to whoever created the room.
// Notes and the rating are stored here and NOT in the shared Yjs document,
// because everything in the document is sent to every participant.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ROOM_TTL_SECONDS } from './config';
import { redis, roomKey } from './redis';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o/1/l lookalikes
const ID_LENGTH = 10; // 32^10 = 2^50 possible ids, far too many to guess
export const ROOM_ID_PATTERN = /^[a-z0-9]{10}$/;

export interface InterviewData {
  notes: string;
  rating: number; // 0 = not rated yet, otherwise 1..5
}

export async function createRoom(): Promise<{ roomId: string; interviewerKey: string }> {
  let roomId = '';
  // WHY randomInt and not Math.random: ids act as passwords for the room, so
  // they must come from a cryptographically secure generator.
  for (let i = 0; i < ID_LENGTH; i++) roomId += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  const interviewerKey = randomBytes(16).toString('base64url');
  await redis
    .multi()
    .hset(roomKey(roomId), { createdAt: Date.now(), interviewerKey, notes: '', rating: 0 })
    .expire(roomKey(roomId), ROOM_TTL_SECONDS)
    .exec();
  return { roomId, interviewerKey };
}

export async function getRoomInfo(roomId: string): Promise<{ createdAt: number } | null> {
  if (!ROOM_ID_PATTERN.test(roomId)) return null;
  const createdAt = await redis.hget(roomKey(roomId), 'createdAt');
  return createdAt ? { createdAt: Number(createdAt) } : null;
}

export async function isInterviewer(roomId: string, key: string | undefined): Promise<boolean> {
  if (!key || !ROOM_ID_PATTERN.test(roomId)) return false;
  const expected = await redis.hget(roomKey(roomId), 'interviewerKey');
  if (!expected) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  // WHY timingSafeEqual: a normal === stops at the first different character,
  // so response time leaks how much of the key was right. This does not.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function getInterviewData(roomId: string): Promise<InterviewData> {
  const [notes, rating] = await redis.hmget(roomKey(roomId), 'notes', 'rating');
  return { notes: notes ?? '', rating: Number(rating ?? 0) };
}

export async function saveInterviewData(roomId: string, data: InterviewData): Promise<void> {
  await redis.hset(roomKey(roomId), { notes: data.notes, rating: data.rating });
}
