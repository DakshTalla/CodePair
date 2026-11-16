// CRDT convergence: the property the whole editor relies on.
//
// "Convergence" means: once every replica has received every update, all
// replicas hold exactly the same text, no matter in which order the updates
// arrived or how many times each one was delivered. These tests use no network
// and no Redis, only Yjs documents passing updates to each other.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

// Small seeded random generator so a failing run can be reproduced exactly.
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('CRDT convergence', () => {
  it('merges two concurrent inserts at the same position identically on both sides', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('code').insert(0, 'print(1)');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Both type at index 0 without having seen the other's edit.
    a.getText('code').insert(0, 'AAA');
    b.getText('code').insert(0, 'BBB');
    const fromA = Y.encodeStateAsUpdate(a);
    const fromB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, fromB);
    Y.applyUpdate(b, fromA);

    const merged = a.getText('code').toString();
    expect(b.getText('code').toString()).toBe(merged);
    // Neither edit is lost and neither is interleaved character by character.
    expect(['AAABBBprint(1)', 'BBBAAAprint(1)']).toContain(merged);
  });

  it('merges an edit made offline when the replica reconnects', () => {
    const online = new Y.Doc();
    const offline = new Y.Doc();
    online.getText('code').insert(0, 'def f():\n    pass\n');
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(online));

    offline.getText('code').insert(0, '# written offline\n');
    online.getText('code').delete(13, 4); // remove "pass"
    online.getText('code').insert(13, 'return 1');

    // On reconnect each side sends only what the other is missing.
    const missingOnline = Y.encodeStateAsUpdate(offline, Y.encodeStateVector(online));
    const missingOffline = Y.encodeStateAsUpdate(online, Y.encodeStateVector(offline));
    Y.applyUpdate(online, missingOnline);
    Y.applyUpdate(offline, missingOffline);

    expect(online.getText('code').toString()).toBe('# written offline\ndef f():\n    return 1\n');
    expect(offline.getText('code').toString()).toBe(online.getText('code').toString());
  });

  it('applying the same update twice changes nothing (idempotent)', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('code').insert(0, 'hello');
    const update = Y.encodeStateAsUpdate(a);
    Y.applyUpdate(b, update);
    Y.applyUpdate(b, update);
    expect(b.getText('code').toString()).toBe('hello');
  });

  it('3 replicas converge after random edits delivered out of order with duplicates (50 trials x 300 ops)', () => {
    const TRIALS = 50;
    const REPLICAS = 3;
    const OPS = 300;
    for (let trial = 0; trial < TRIALS; trial++) {
      const random = seededRandom(trial + 1);
      const docs = Array.from({ length: REPLICAS }, () => new Y.Doc());
      // inbox[i] = updates that have been sent to replica i but not delivered yet.
      const inbox: Uint8Array[][] = docs.map(() => []);
      docs.forEach((doc, i) => {
        doc.on('update', (update: Uint8Array, origin: unknown) => {
          if (origin === 'network') return; // only forward a replica's own edits
          inbox.forEach((queue, j) => j !== i && queue.push(update));
        });
      });

      const deliverOne = (i: number) => {
        const queue = inbox[i];
        if (queue.length === 0) return;
        // A random message, not the oldest: simulates reordering.
        const [update] = queue.splice(Math.floor(random() * queue.length), 1);
        Y.applyUpdate(docs[i], update, 'network');
        if (random() < 0.1) Y.applyUpdate(docs[i], update, 'network'); // duplicate delivery
      };

      for (let op = 0; op < OPS; op++) {
        const i = Math.floor(random() * REPLICAS);
        const text = docs[i].getText('code');
        if (text.length > 0 && random() < 0.3) {
          const index = Math.floor(random() * text.length);
          text.delete(index, Math.min(text.length - index, 1 + Math.floor(random() * 3)));
        } else {
          const index = Math.floor(random() * (text.length + 1));
          text.insert(index, String.fromCharCode(97 + Math.floor(random() * 26)));
        }
        // Deliver only some messages now, so replicas keep editing stale text.
        if (random() < 0.5) deliverOne(Math.floor(random() * REPLICAS));
      }
      // Eventually everything is delivered.
      docs.forEach((_, i) => {
        while (inbox[i].length > 0) deliverOne(i);
      });

      const texts = docs.map((doc) => doc.getText('code').toString());
      expect(texts[1], `trial ${trial}`).toBe(texts[0]);
      expect(texts[2], `trial ${trial}`).toBe(texts[0]);
    }
  });

  it('replaying a recorded update log reproduces every intermediate state', () => {
    // This is exactly how session replay works: the server stores each update,
    // and the replay page applies the first N of them to an empty document.
    const live = new Y.Doc();
    const log: Uint8Array[] = [];
    const snapshots: string[] = [];
    live.on('update', (update: Uint8Array) => {
      log.push(update);
      snapshots.push(live.getText('code').toString());
    });
    const text = live.getText('code');
    for (const ch of 'print("hi")') text.insert(text.length, ch);
    text.delete(7, 2);
    text.insert(7, 'bye');

    for (let n = 1; n <= log.length; n++) {
      const replay = new Y.Doc();
      for (const update of log.slice(0, n)) Y.applyUpdate(replay, update);
      expect(replay.getText('code').toString()).toBe(snapshots[n - 1]);
    }
    expect(snapshots.at(-1)).toBe('print("bye")');
  });
});
