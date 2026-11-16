// Entry point: one HTTP server that serves the REST API and upgrades
// /ws/<roomId> requests to WebSockets for real-time sync.
//
// REST API
//   POST /api/rooms                  create a room -> { roomId, interviewerKey }
//   GET  /api/rooms/:id              does the room exist?
//   POST /api/rooms/:id/run          run the room's code in the sandbox
//   GET  /api/rooms/:id/recording    every update, with timestamps, for replay
//   -- interviewer only (header x-interviewer-key) --
//   GET  /api/rooms/:id/interview    private notes + rating
//   PUT  /api/rooms/:id/interview    save them
//   GET  /api/rooms/:id/questions    question bank including hints
//   POST /api/rooms/:id/question     show a question to everyone in the room

import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { PORT, SANDBOX } from './config';
import { QUESTIONS, toPublic } from './questions';
import { redis, runLockKey } from './redis';
import { createRoom, getInterviewData, getRoomInfo, isInterviewer, saveInterviewData } from './rooms';
import { isLanguage, runCode, SandboxBusyError, type RunResult } from './sandbox';
import { handleConnection, loadedRoomCount, readLog, startPubSub, withRoom } from './sync';

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  // The web app is served from a different port, so the browser needs CORS
  // headers before it will call this API.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.WEB_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-interviewer-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', async (_req, res) => {
    res.json({ ok: (await redis.ping()) === 'PONG', loadedRooms: loadedRoomCount() });
  });

  app.post('/api/rooms', async (_req, res) => {
    res.status(201).json(await createRoom());
  });

  // Every /api/rooms/:id route first checks that the room exists.
  app.param('id', async (_req, res, next, id: string) => {
    if (await getRoomInfo(id)) return next();
    res.status(404).json({ error: 'Room not found' });
  });

  app.get('/api/rooms/:id', async (req, res) => {
    res.json(await getRoomInfo(req.params.id));
  });

  app.get('/api/rooms/:id/recording', async (req, res) => {
    res.json(await readLog(req.params.id));
  });

  app.post('/api/rooms/:id/run', async (req, res) => {
    const roomId = req.params.id;
    // WHY a lock in Redis and not a variable: with several server processes,
    // only shared state can guarantee one run per room. NX = "set only if
    // absent"; EX = expire by itself if this server crashes mid-run.
    const locked = await redis.set(runLockKey(roomId), '1', 'EX', 30, 'NX');
    if (!locked) return res.status(409).json({ error: 'A run is already in progress' });
    try {
      const result = await withRoom(roomId, async (room) => {
        const state = room.doc.getMap('state');
        const rawLanguage = state.get('language');
        const language = isLanguage(rawLanguage) ? rawLanguage : 'python';
        // WHY the code is read from the server's copy of the document and not
        // from the request body: what runs is exactly what everyone sees.
        const code = room.doc.getText('code').toString();
        const by = String(req.body?.name ?? 'Someone').slice(0, 40);
        // Writing to the shared map shows "running..." and then the output to
        // every participant, and records both for the replay.
        state.set('run', { status: 'running', by, language });
        let result: RunResult;
        if (Buffer.byteLength(code) > SANDBOX.maxCodeBytes) {
          result = { status: 'error', stdout: '', stderr: 'Code is too large to run', exitCode: null, timeMs: 0 };
        } else {
          try {
            result = await runCode(language, code);
          } catch (err) {
            if (!(err instanceof SandboxBusyError)) throw err;
            result = { status: 'error', stdout: '', stderr: err.message, exitCode: null, timeMs: 0 };
          }
        }
        state.set('run', { ...result, by, language, at: Date.now() });
        return result;
      });
      res.json(result);
    } finally {
      await redis.del(runLockKey(roomId));
    }
  });

  // ---- interviewer-only routes ----

  const requireInterviewer = async (req: Request, res: Response, next: NextFunction) => {
    if (await isInterviewer(String(req.params.id), req.header('x-interviewer-key'))) return next();
    res.status(403).json({ error: 'Interviewer key required' });
  };

  app.get('/api/rooms/:id/interview', requireInterviewer, async (req, res) => {
    res.json(await getInterviewData(String(req.params.id)));
  });

  app.put('/api/rooms/:id/interview', requireInterviewer, async (req, res) => {
    const notes = String(req.body?.notes ?? '').slice(0, 20_000);
    const rating = Math.min(5, Math.max(0, Math.round(Number(req.body?.rating) || 0)));
    await saveInterviewData(String(req.params.id), { notes, rating });
    res.json({ notes, rating });
  });

  app.get('/api/rooms/:id/questions', requireInterviewer, (_req, res) => {
    res.json(QUESTIONS);
  });

  app.post('/api/rooms/:id/question', requireInterviewer, async (req, res) => {
    const question = QUESTIONS.find((q) => q.id === req.body?.questionId);
    if (!question) return res.status(400).json({ error: 'Unknown question' });
    await withRoom(String(req.params.id), async (room) => {
      room.doc.getMap('state').set('question', toPublic(question)); // hints removed
    });
    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export async function startServer(port = PORT): Promise<Server> {
  const server = createServer(buildApp());
  // noServer: we decide which upgrade requests become WebSockets.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const match = /^\/ws\/([a-z0-9]+)/.exec(req.url ?? '');
    const roomId = match?.[1];
    if (!roomId || !(await getRoomInfo(roomId).catch(() => null))) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, roomId));
  });

  await startPubSub();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

// Start only when run directly (`tsx src/index.ts`), not when a test imports it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(() => console.log(`CodePair server listening on http://localhost:${PORT}`));
}
