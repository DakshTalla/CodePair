# CodePair study guide

Read this before interviews. It explains every design decision in plain words, gives the questions an interviewer is likely to ask with answers, and walks through every file.

Contents

1. [The 60-second pitch](#1-the-60-second-pitch)
2. [Resume bullets](#2-resume-bullets)
3. [CRDT vs OT](#3-crdt-vs-ot)
4. [How Yjs works (just enough)](#4-how-yjs-works-just-enough)
5. [The sync protocol on the wire](#5-the-sync-protocol-on-the-wire)
6. [Redis: what it does here](#6-redis-what-it-does-here)
7. [Sandbox security](#7-sandbox-security)
8. [Session replay](#8-session-replay)
9. [Interviewer privacy](#9-interviewer-privacy)
10. [File-by-file walkthrough](#10-file-by-file-walkthrough)
11. [Interview questions and answers](#11-interview-questions-and-answers)
12. [Numbers to remember](#12-numbers-to-remember)

---

## 1. The 60-second pitch

> "CodePair is a collaborative coding interview tool, like a small CoderPad. Two people edit the same code in real time. I used a CRDT, Yjs, so concurrent edits merge without a central lock or a transform step. A Node/TypeScript server relays the binary updates over WebSockets and appends each one to a Redis list. That list is both the saved document and a keystroke-level recording, so the replay page can rebuild the document at any moment. Code runs in a throwaway Docker container with no network, a memory cap, a CPU cap, a process limit, a read-only filesystem and a non-root user, and I wrote tests that attack each of those limits. The interviewer gets a private question bank, notes and a rating that never reach the candidate's browser. Locally a keystroke reaches the other client in 0.16 ms at the median, and a sandboxed Python run takes about half a second end to end."

## 2. Resume bullets

Pick the version that fits the space. All numbers are from `npm run bench` and `npm test` (see section 12).

- Built **CodePair**, a real-time collaborative coding interview platform (Node.js, TypeScript, Next.js, Monaco). Concurrent edits are merged with the **Yjs CRDT** over WebSockets, with live cursors and presence. Measured **0.16 ms p50 / 0.53 ms p95** client-to-client sync latency (localhost), and 5 clients making 2,000 concurrent edits converged in **453 ms**.
- Designed a **Docker sandbox** for untrusted Python/JavaScript/C++ code: no network, 256 MB memory, 1 CPU, 64-process cap, 10 s timeout, read-only root, non-root user, all capabilities dropped. **14 sandbox tests** cover these limits (infinite loop, memory bomb, fork bomb, output flood, network and filesystem escape). A full Python run, including container start, takes a **515 ms median**.
- Used **Redis** for room state, a distributed run lock and **pub/sub fan-out across server processes**. Every CRDT update (~**20 bytes**) goes into a timestamped log that powers **keystroke-by-keystroke session replay** with a timeline scrubber and rebuilds a ~2,000-update room in **19 ms**. Backed by **27 automated tests**, including randomized convergence checks (50 trials × 300 edits with reordered and duplicated delivery).

## 3. CRDT vs OT

Both solve the same problem: two people edit the same text at the same time, and everyone must end with the same result that keeps both people's intent.

**The problem in one example.** The text is `abc`. Alice inserts `X` at index 1 (`aXbc`). At the same moment Bob deletes index 2, the `c` (`ab`). If each side naively applies the other's operation by index:

- Alice applies "delete index 2" to `aXbc` and deletes `b`. Wrong.
- Bob applies "insert X at 1" to `ab` and gets `aXb`.

Alice has `aXc` and Bob has `aXb`. They have diverged.

### OT (Operational Transformation), used by Google Docs

- Operations are index-based ("insert X at 1").
- When an operation arrives that was made concurrently with yours, you **transform** it against your own: "Bob's delete at 2 was made before my insert at 1, so it now means delete at 3."
- It is usually done with a **central server** that defines one order of operations. Clients transform against whatever they have not yet seen.
- **Pros:** small operations, mature (decades of use), and the document holds no extra metadata.
- **Cons:** the transform functions are notoriously hard to get right for every pair of operation types (many published OT algorithms were later shown to be wrong). It needs a server to order operations, and offline editing is awkward.

### CRDT (Conflict-free Replicated Data Type), used here (Yjs)

- Every inserted character gets a **unique, permanent id**: (client id, counter). An insert says "put X right after the character with id (Alice, 5)", not "at index 1".
- Ids never change, so no transform is needed. Bob's delete names the exact character it removes, wherever that character has moved to.
- Concurrent inserts at the same spot are ordered by a deterministic rule (Yjs uses the YATA algorithm). Every replica picks the same order.
- Merging is **commutative** (any order), **associative** (any grouping) and **idempotent** (duplicates are harmless). So any replica that has received the same set of updates holds the same document. That property is called *strong eventual consistency*.
- **Pros:** no central ordering, so it works peer to peer, offline, or across many servers. The server can be a dumb relay. Easy to reason about.
- **Cons:** metadata overhead (ids, and tombstones for deleted characters). Yjs keeps this small by grouping consecutive characters typed by one client into one item, which is why an average update here is only ~20 bytes.

### Why I chose a CRDT

1. **The server stays simple.** [sync.ts](../server/src/sync.ts) has no conflict logic; it applies and forwards updates. With OT the server would have to transform every operation.
2. **Multiple servers just work.** Updates can arrive at server 2 through Redis in any order and still converge. With OT I would need one ordering authority.
3. **Replay comes for free.** The update log *is* the history. Applying the first N updates gives the exact state after N edits.
4. **Yjs is battle-tested** (used by JupyterLab, Evernote and others), and writing my own OT would be a bug farm.

### Common follow-ups

- *"Does a CRDT always keep the user's intent?"* It guarantees convergence, not perfect intent. If two people fix the same typo differently, you get both fixes. For code interviews, with two people typing in different places, that is fine.
- *"What are tombstones?"* Deleted characters are kept as markers so that concurrent inserts that reference them still have an anchor. Yjs garbage-collects their content and keeps only small markers.
- *"Is the server authoritative?"* No. It is just another replica, one that is always online. That also means a malicious client could send a huge or junk update. I cap WebSocket messages at 1 MB; a production system would add auth and rate limits.

## 4. How Yjs works (just enough)

- `Y.Doc` is the document. Inside it are named shared types. I use three:
  - `doc.getText('code')`: the editor contents (`Y.Text`).
  - `doc.getMap('state')`: language, current question, last run output (`Y.Map`).
  - `doc.getArray('chat')`: chat messages (`Y.Array`).
- Every change happens in a **transaction**, and each transaction emits one **update**: a compact binary diff. `doc.on('update', ...)` receives it.
- `Y.applyUpdate(doc, update, origin)` merges an update. `origin` is a free tag passed to listeners. I use it to avoid echoes: the server tags updates from Redis with `FROM_REDIS` so it does not save or publish them again, and the editor binding tags its own edits `LOCAL`.
- **State vector:** for each client id, how many of its operations I have seen. `Y.encodeStateAsUpdate(doc, theirStateVector)` produces exactly what they are missing. That is how sync works after a reconnect.
- **Awareness** is a separate, small protocol for temporary per-user state (name, colour, cursor). It is not part of the document, it is not saved, and it disappears when a user leaves or goes silent for 30 seconds.
- **Relative positions:** a cursor saved as "offset 42" goes wrong when someone types before it. `Y.createRelativePositionFromTypeIndex` stores "next to the character with id X" instead, which stays correct. I send cursors this way.
- **UndoManager:** undoes only transactions with chosen origins. I track `LOCAL`, so Ctrl+Z undoes *my* typing and never the other person's.

## 5. The sync protocol on the wire

Every WebSocket message is binary. Its first number is the message type. These numbers are fixed by the `y-websocket` client:

| Type | Meaning |
|---|---|
| `0` sync | document data, with a sub-type: step 1, step 2 or update |
| `1` awareness | presence (names, cursors) |

When a client connects:

1. **Server → client: sync step 1**, the server's state vector ("this is what I have").
2. **Client → server: sync step 2**, everything the server is missing. The client also sends **its own step 1**.
3. **Server → client: sync step 2**, everything the client is missing.
4. From then on both sides send **update** messages as edits happen.

`syncProtocol.readSyncMessage` in [sync.ts](../server/src/sync.ts) handles all three sub-types and writes any reply. The server also sends the current awareness states to the newcomer, so cursors appear immediately.

Why the server echoes awareness to the sender: the client library treats a connection that has received nothing for 30 seconds as dead and reconnects. Awareness heartbeats arrive every 15 seconds, so echoing them keeps a quiet connection alive.

## 6. Redis: what it does here

| Key / channel | Type | Purpose |
|---|---|---|
| `cp:room:<id>` | hash | `createdAt`, `interviewerKey`, `notes`, `rating` |
| `cp:room:<id>:log` | list | `"<ms timestamp>\|<base64 update>"` per edit: persistence **and** the replay recording |
| `cp:room:<id>:runlock` | string | `SET NX EX 30`: one code run per room at a time |
| `cp:pub:<id>` | pub/sub channel | fan out updates and awareness to other server processes |

Things to be able to explain:

- **Why Redis and not Postgres?** The data is small, short-lived and accessed by key. I need fast appends (`RPUSH`), expiry (`EXPIRE`), an atomic lock (`SET NX`) and pub/sub, and Redis has all four built in. Postgres would be a better choice for long-term interview records with accounts and search.
- **Why two Redis connections?** A connection in subscribe mode cannot run normal commands.
- **Why `MULTI` for the append?** The `RPUSH` and both `EXPIRE`s are sent together in one round trip and run back to back.
- **Echo avoidance in pub/sub:** each server has a random `INSTANCE_ID`, included in every message, and ignores its own messages. Updates received from Redis are applied with origin `FROM_REDIS`, which is never saved or republished, so a message cannot loop forever.
- **Why the run lock is in Redis:** with two server processes, an in-memory flag on one process cannot stop a run on the other. `NX` = only set if absent, `EX 30` = auto-expires if the server crashes mid-run, so a room can never be locked forever.
- **Loading a room:** the first connection replays the whole log into a fresh `Y.Doc` (19 ms for ~2,000 updates). The room is dropped from memory when the last socket leaves. A map of *promises* ensures two simultaneous joiners share one load instead of creating two documents.
- **Durability:** Redis runs with `--appendonly yes`, so data survives a Redis restart.

## 7. Sandbox security

**Threat model:** the code is written by a stranger and may be hostile. Every `docker run` flag in [sandbox.ts](../server/src/sandbox.ts) answers one attack:

| Attack | Defence | Tested by |
|---|---|---|
| Infinite loop | wall-clock timer → `docker kill` after 10 s | `time limit` test |
| Eat all CPU | `--cpus 1` (CFS quota) | (enforced by the kernel) |
| Allocate until the host dies | `--memory 256m --memory-swap 256m` → OOM killer, exit 137 | `memory limit` test |
| Fork bomb | `--pids-limit 64` → `fork()` fails | `process limit` test |
| Print gigabytes | stop reading and kill at 64 KB of output | `output limit` test |
| Call out to the internet / attack the LAN | `--network none` (only loopback exists) | `no network` test |
| Modify system files, plant binaries | `--read-only` root filesystem; only a 32 MB in-memory `/tmp` is writable | `read-only filesystem` test |
| Read host files | nothing is mounted; the code arrives on **stdin** | (by construction) |
| Use root powers | `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges` | `non-root user` test |
| Fill the disk / leave junk behind | `--rm`; tmpfs disappears with the container | `leaves no container behind` test |
| Overload the host with many runs | at most 4 containers at once, plus one run per room (Redis lock) | `refuses to start more than the allowed number` test |

Details worth knowing:

- **Why `--memory-swap` equal to `--memory`:** otherwise the container may also use swap of the same size, and the "256 MB" cap is really 512 MB.
- **Why exit code 137 means OOM:** 137 = 128 + 9 (SIGKILL). If the timeout did not fire and our code did not kill the container, the kernel's OOM killer did.
- **Why `docker kill` and not killing the child process:** the child is just the `docker` CLI. Killing it leaves the container running. `docker kill <name>` stops the processes inside the container.
- **Why `/tmp` needs `exec`:** the C++ program is compiled into `/tmp` and then executed from there. `nosuid` is still set.
- **Why one image for all languages:** a single small Alpine image (python3, nodejs, g++) is easier to build, cache and audit than three.
- **Cold start cost:** about 0.5 s per run, mostly container creation. A pool of pre-started, paused containers would cut this, at the cost of more complexity.

**The honest limitation:** containers share the host's Linux kernel. A kernel bug could let code escape. Stronger options:

- **gVisor** (`--runtime=runsc`): a user-space kernel that intercepts system calls. Same `docker run`, much smaller attack surface.
- **Firecracker micro-VMs** (used by AWS Lambda): a real VM per run that boots in ~125 ms.
- **seccomp profile:** Docker already applies a default one that blocks ~44 dangerous syscalls; a custom one could be stricter.
- Run the sandbox host on **separate machines** from the app servers and the database.

## 8. Session replay

- The server's `doc.on('update')` handler appends `Date.now() + '|' + base64(update)` to the room's Redis list. One local edit is one Yjs transaction, which is one update, so the log is keystroke-level.
- `GET /api/rooms/:id/recording` returns the list.
- The replay page ([Replay.tsx](../web/components/Replay.tsx)) keeps its own `Y.Doc`:
  - **Moving forward** from N to M: apply updates N..M-1. Cheap.
  - **Moving backward:** CRDT updates cannot be un-applied, so it starts from an empty document and applies 0..M-1. With ~2,000 updates this is instant. For huge logs, I would save a snapshot every few hundred updates and start from the nearest one.
- **Playback timing** uses the real gaps between timestamps, divided by the speed, with pauses capped at 1.5 s so dead time is skipped.
- **Caret marker:** while applying updates, a `Y.Text` observer reads each change's delta (retain / insert / delete) to find where the last edit happened, and that spot is highlighted.
- **Run markers:** one pass over the log watches the `run` key of the `state` map and records the index of each finished run (green = exit 0, red = anything else).
- Because code, output and chat live in one document, **one slider replays all three in sync**.

## 9. Interviewer privacy

Rule: **anything in the Yjs document is visible to everyone** (it is sent to every browser). So private data must stay out of the document.

- Notes and the rating are stored in the Redis hash and served only by routes that check `x-interviewer-key`.
- The question bank is served with hints only to the interviewer. When the interviewer picks a question, the **server** writes it into the document with the hints removed (`toPublic` in [questions.ts](../server/src/questions.ts)).
- The key is compared with `crypto.timingSafeEqual`, so the response time does not leak how many characters were right.
- The key is generated with `crypto.randomBytes(16)` (128 bits); room ids use `crypto.randomInt` (50 bits). Neither uses `Math.random`, which is predictable.
- The key travels in the URL **fragment** (`#key=...`), which browsers never send to servers, then moves to `localStorage` and is removed from the address bar.
- A test checks that the candidate's copy of the document does not contain the notes and that the question has no `hints` field.
- **Cursor labels and CSS injection:** remote names and colours are placed into a `<style>` tag. The colour must match `#rrggbb` and the name is stripped to letters, digits, spaces, `.`, `_` and `-`, so a malicious name cannot break out of the CSS. Chat and problem statements are rendered as React text, never as HTML, so they cannot run scripts.

## 10. File-by-file walkthrough

### Root

- **`start.ps1`**: one-command start. Checks Docker, runs `docker compose up -d` (Redis), builds the sandbox image if it is missing, installs npm packages on the first run, then runs `npm run dev`.
- **`package.json`**: `npm run dev` uses `concurrently` to run the server and web app side by side. Also `test`, `typecheck` and `bench`.
- **`docker-compose.yml`**: only Redis, on `127.0.0.1:6380` (6379 is often taken; binding to 127.0.0.1 keeps it off the network), with append-only persistence.
- **`sandbox/Dockerfile`**: Alpine plus python3, nodejs and g++, running as user 1000. No code is baked in.
- **`scripts/screenshots.mjs`**: drives two real Edge browsers through a whole interview with `playwright-core`. It creates a room, picks a question, has both people type at the same time, runs the code, writes notes, and opens the replay. It asserts that both editors are identical, that the output reached both, that the candidate cannot see the interviewer tab, and that the replay ends at the final text. Then it saves the screenshots.

### Server (`server/src`)

- **`config.ts`**: port, Redis URL, room TTL, and every sandbox limit in one object. All values can be overridden with environment variables.
- **`redis.ts`**: two `ioredis` connections (commands + subscriber), with `lazyConnect` so importing the file in a unit test does not connect. Defines the key names.
- **`rooms.ts`**: `createRoom` (secure random id + key, stored in a hash with a TTL), `getRoomInfo`, `isInterviewer` (constant-time compare), and get/save for notes and rating.
- **`sync.ts`**: the heart of the server.
  - `getRoom` / `loadRoom`: one `Y.Doc` + `Awareness` per active room, rebuilt from the Redis log; a map of promises prevents double loads.
  - The doc `update` listener: broadcasts to the other sockets, appends to the Redis log (unless the update came from Redis), and publishes on pub/sub.
  - The awareness `update` listener: tracks which awareness ids belong to which socket (so a closed socket's cursor can be removed), broadcasts, and publishes.
  - `startPubSub`: one pattern subscription, `cp:pub:*`; ignores its own instance's messages.
  - `handleConnection`: sends sync step 1 and the current awareness, queues incoming messages until the room has loaded, and cleans up on close.
  - `withRoom`: lets HTTP handlers use a room and keeps it loaded while they do.
  - `unloadIfUnused`: frees memory when nobody is connected.
- **`sandbox.ts`**: `dockerArgs` builds the `docker run` command (every flag has a WHY comment). `runCode` spawns it, pipes the code to stdin, collects output up to the limit, starts the timeout, kills by container name, and maps the exit to `ok` / `error` / `timeout` / `oom` / `output_limit`. There is a global concurrency cap.
- **`questions.ts`**: 8 questions (3 easy, 4 medium, 1 hard) with statements and interviewer hints. `toPublic` removes the hints.
- **`index.ts`**: the Express app and the WebSocket upgrade.
  - CORS headers (the web app is on another port).
  - `app.param('id')` returns 404 for unknown rooms on every route.
  - `POST /run` takes the Redis lock, reads the code from the **server's copy of the document** (so what runs is exactly what everyone sees), writes "running" and then the result into the shared `state` map, and releases the lock in `finally`.
  - Interviewer routes go through `requireInterviewer`.
  - The `upgrade` handler accepts `/ws/<roomId>` only for rooms that exist.
  - The server starts only when the file is run directly, so tests can import `startServer`.

### Server tests (`server/test`)

- **`crdt.test.ts`**: pure Yjs, no network.
  - Two concurrent inserts at the same index merge identically on both sides.
  - An offline edit merges on reconnect, using state vectors.
  - Applying the same update twice changes nothing.
  - **Randomized:** 3 replicas, 50 seeded trials × 300 random inserts and deletes, with random delivery order and 10% duplicate delivery; all replicas must match.
  - Replaying the first N updates reproduces every intermediate state.
- **`sandbox.test.ts`**: checks the flags, then real containers: Python, JavaScript, C++, a compile error, an exit code, and the limits (timeout, OOM, fork bomb, output flood, network, read-only + non-root, concurrency cap, no leftover containers). Skipped if the image is missing.
- **`sync.test.ts`**: real server + real WebSocket clients + real Redis.
  - Rejects unknown rooms.
  - Concurrent typing converges.
  - Presence appears and disappears.
  - A late joiner gets the document from Redis after everyone has left.
  - The recording has one entry per keystroke and replays exactly.
  - Notes are private and hints are stripped.
  - Run output reaches the other client.
  - A **second server process** on another port syncs edits and presence through pub/sub.

### Web (`web/`)

- **`lib/api.ts`**: the server URL, shared TypeScript types, a `fetch` wrapper that throws `ApiError`, the name stored in `localStorage`, and `takeInterviewerKey` (fragment → `localStorage` → clean the address bar).
- **`lib/yMonaco.ts`**: my own Monaco ↔ Yjs binding (~150 lines; the `y-monaco` package does the same).
  1. **Local edits → Y.Text:** the changes in one event all refer to the text *before* the event, so they are applied from the highest offset down, and an earlier edit never shifts a later one.
  2. **Remote edits → editor:** walk the delta (retain / insert / delete) and apply each step to the Monaco model, with a flag set so step 1 does not echo it back.
  3. **Line endings forced to `\n`:** Monaco on Windows defaults to `\r\n`, which made every offset after the first line wrong. This was a real bug I found with the end-to-end test.
  4. **Undo:** `Y.UndoManager` bound to Ctrl+Z / Ctrl+Y, tracking only my own edits.
  5. **Cursors:** my selection is sent as relative positions; other users' cursors are drawn as decorations, with a per-user CSS rule for the colour and name label.
- **`lib/hooks.ts`**: `useMapValue`, `useArray` and `useParticipants`, the same pattern each time: read, subscribe, unsubscribe on cleanup.
- **`components/CodeEditor.tsx`**: the Monaco wrapper with a custom theme. Live mode binds to Yjs; replay mode is read-only, showing a value and a caret marker. Ctrl+Enter runs the code. Monaco is served from `public/monaco` (copied by `scripts/copy-monaco.mjs` after `npm install`), not from a CDN.
- **`components/Room.tsx`**:
  - `Room` checks that the room exists, validates any stored interviewer key with the server, asks for a name, then creates the `Y.Doc` + `WebsocketProvider` and sets the awareness `user` field.
  - `Workspace` is the IDE layout: top bar (connection dot, language, Run, avatars, invite link, Replay), left panel (Problem / Interviewer tabs), editor over console, right panel (people + chat).
- **`components/OutputConsole.tsx`**: status badge, stdout, stderr, and who ran it, in which language, how long it took and the exit code.
- **`components/ProblemPanel.tsx`**: the shared problem statement, rendered as text.
- **`components/ChatPanel.tsx`**: `Y.Array` chat; `MessageList` is reused by the replay page.
- **`components/InterviewerPanel.tsx`**: question bank, hints for the current question, a star rating and notes with debounced autosave (saves 600 ms after typing stops).
- **`components/Replay.tsx`**: loads the log, applies updates up to the slider position, play/pause, speed, run markers and keyboard shortcuts. See section 8.
- **`app/`**: Next.js App Router pages. `room/[id]` and `replay/[id]` load their component with `ssr: false`, because WebSockets, `localStorage` and Monaco only exist in the browser.
- **`app/globals.css`**: Tailwind v4 theme tokens (`--color-*` become `bg-*` / `text-*` classes), cursor label styles and the timeline slider.

## 11. Interview questions and answers

**Q: Walk me through what happens when I type a character.**
See "How a keystroke travels" in the README: Monaco change → binding → `Y.Text` insert → binary update → WebSocket → server applies it, forwards it to other sockets, appends it to Redis and publishes it → other clients apply it → their binding writes it into their editor.

**Q: Two people type at the same position at the same moment. What happens?**
Both inserts reference the same left neighbour by id. Yjs orders them by a deterministic rule (YATA, effectively by client id), so both sides end with, for example, `AAABBB`. Neither edit is lost or interleaved character by character. `crdt.test.ts` tests exactly this.

**Q: What if the WebSocket drops for 30 seconds while I keep typing?**
Edits stay in the local `Y.Doc`. On reconnect the client and server exchange state vectors (sync steps 1 and 2) and each sends only what the other is missing. Nothing is lost, and there are no conflicts to resolve.

**Q: How would you scale to 10,000 rooms?**
Rooms are independent, so run many server processes behind a load balancer. Redis pub/sub already keeps the processes in sync, which is tested with two processes. Better still, use **sticky routing by room id** (a consistent hash), so a room usually lives on one process and pub/sub becomes a fallback. Move code execution to a separate pool of sandbox workers fed by a queue, and add log compaction (snapshots) so documents load quickly.

**Q: Why not just send the whole file on every change?**
It is bandwidth-heavy (the whole file per keystroke instead of ~20 bytes), and it is last-writer-wins: concurrent edits overwrite each other.

**Q: Why WebSockets and not HTTP polling or Server-Sent Events?**
Editing needs low-latency messages in both directions. SSE is server-to-client only, and polling adds latency and load. WebSockets give one long-lived, full-duplex connection.

**Q: How do you stop a candidate from running `rm -rf /` or mining crypto?**
`rm -rf /` hits a read-only filesystem inside a throwaway container, so nothing outside `/tmp` can change, and even that disappears. Mining is limited to 1 CPU for 10 seconds with no network to send results. See the table in section 7.

**Q: Is Docker enough isolation?**
For a portfolio or internal tool, with these flags, it is reasonable. For a public product, no. Containers share the kernel, so I would add gVisor or Firecracker and run the sandboxes on separate hosts. Saying this clearly is better than over-claiming.

**Q: How did you test the sandbox?**
With real hostile programs, not mocks: an infinite loop, a list that grows forever, a fork bomb that keeps its children alive, an infinite print, a TCP connection to 1.1.1.1, and a write to `/etc`. Each test asserts the expected status (timeout / oom / fork failure / output_limit / blocked).

**Q: What was the hardest bug?**
Windows line endings. Monaco on Windows used `\r\n`, while `Y.Text` offsets count one character per newline. After the first newline every remote edit landed one character off per line, which produced garbage like `seen = {}}`. My two-browser end-to-end script caught it, because it compares both editors' text. The fix: force LF after `setValue` (setting it before did not stick, because `setValue` resets the line ending).

Runner-up: the connection indicator showed "Reconnecting" while connected. The socket opened before React attached the status listener, so the "connected" event was missed. The fix was to read `provider.wsconnected` right after subscribing. Lesson: when you subscribe to events, also read the current state.

**Q: Why is the run output in the shared document instead of the HTTP response?**
So that everyone sees it, including people who did not press Run, and so it is part of the replay. The HTTP response is still returned, mainly for tests.

**Q: Why does the server read the code from its own document instead of the request body?**
What runs is exactly what everyone sees. A client cannot show one thing and run another.

**Q: How do you keep the interviewer's notes away from the candidate?**
They are never in the Yjs document. They are stored in Redis and served only with the interviewer key. See section 9.

**Q: Why did you write your own Monaco binding instead of using `y-monaco`?**
`y-monaco` imports the `monaco-editor` package directly, which clashed with loading Monaco through `@monaco-editor/react` in Next.js. Writing it myself also meant I could explain every line. It is about 150 lines and covered by the end-to-end test.

**Q: What would you add next?**
Log compaction with snapshots, accounts and auth, stdin support for programs, a gVisor runtime, pre-warmed containers to cut the ~0.5 s start time, test cases per question with automatic grading, and video/audio through WebRTC.

**Q: What is the time complexity of reloading a room?**
O(total update size), because the server replays every update. 19 ms for ~2,000 updates. With snapshots it becomes O(snapshot + updates since the snapshot).

**Q: What happens if Redis goes down?**
Connected users keep editing, because the document is in memory and is still broadcast. Saving fails and is logged, and new rooms and code runs fail, since they need Redis. When Redis returns, ioredis reconnects automatically, but updates made during the outage are only in memory. They would be lost if the server also restarted.

## 12. Numbers to remember

From [benchmarks.json](benchmarks.json) (localhost, Intel Core Ultra 5 225H) and the test suite:

| Number | Meaning |
|---|---|
| **0.16 ms** p50, 0.53 ms p95 | keystroke from client A to client B through the server |
| **453 ms** | 5 clients × 400 concurrent edits fully converged |
| **~20 bytes** | average size of one recorded edit |
| **19 ms** | rebuild a ~2,000-update room from Redis |
| **515 / 562 / 767 ms** | median full run for Python / JavaScript / C++ (container start → output → removal) |
| **2.45 s** | an infinite loop with a 2 s limit, killed and returned |
| **27 tests** | 5 CRDT, 14 sandbox, 8 end-to-end sync |
| **50 × 300** | randomized convergence trials × edits each |
| **256 MB / 1 CPU / 10 s / 64 pids / 64 KB** | sandbox limits |
| **8** | questions in the bank |
