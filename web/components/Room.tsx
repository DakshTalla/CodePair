'use client';

// The interview room. `Room` handles everything before you are in (does the
// room exist? what is your name? are you the interviewer?) and then renders
// `Workspace`, the IDE layout, once a live connection exists.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import {
  api,
  ApiError,
  LANGUAGES,
  loadName,
  randomColor,
  saveName,
  takeInterviewerKey,
  WS_URL,
  type ChatMessage,
  type Language,
  type Question,
  type RunState,
} from '@/lib/api';
import { useMapValue, useParticipants } from '@/lib/hooks';
import ChatPanel from './ChatPanel';
import CodeEditor from './CodeEditor';
import InterviewerPanel from './InterviewerPanel';
import OutputConsole from './OutputConsole';
import ProblemPanel from './ProblemPanel';

interface Session {
  doc: Y.Doc;
  provider: WebsocketProvider;
  me: { name: string; color: string; role: 'interviewer' | 'candidate' };
  interviewerKey: string | null;
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-accent to-accent-strong font-mono text-[10px] text-white">
        {'</>'}
      </span>
      CodePair
    </Link>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-screen place-items-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8 shadow-2xl">{children}</div>
    </div>
  );
}

export default function Room({ roomId }: { roomId: string }) {
  const [phase, setPhase] = useState<'checking' | 'missing' | 'offline' | 'name' | 'ready'>('checking');
  const [name, setName] = useState('');
  const [interviewerKey, setInterviewerKey] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);

  // Step 1: check the room and whether we hold a valid interviewer key.
  useEffect(() => {
    (async () => {
      try {
        await api(`/api/rooms/${roomId}`);
        let key = takeInterviewerKey(roomId);
        if (key) {
          // Never trust the stored key blindly: ask the server.
          await api(`/api/rooms/${roomId}/interview`, { interviewerKey: key }).catch(() => (key = null));
        }
        setInterviewerKey(key);
        const saved = loadName();
        setName(saved);
        setPhase(saved ? 'ready' : 'name');
      } catch (err) {
        setPhase(err instanceof ApiError && err.status === 404 ? 'missing' : 'offline');
      }
    })();
  }, [roomId]);

  // Step 2: once we have a name, open the document and the WebSocket.
  useEffect(() => {
    if (phase !== 'ready') return;
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(WS_URL, roomId, doc);
    const me: Session['me'] = {
      name,
      color: randomColor(),
      role: interviewerKey ? 'interviewer' : 'candidate',
    };
    // Awareness = small per-user state that is shared but not saved.
    provider.awareness.setLocalStateField('user', me);
    setSession({ doc, provider, me, interviewerKey });
    return () => {
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roomId]);

  if (phase === 'missing' || phase === 'offline') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{phase === 'missing' ? 'Room not found' : 'Server unreachable'}</h1>
        <p className="mt-2 text-sm text-muted">
          {phase === 'missing'
            ? 'This link is wrong or the room has expired (rooms are kept for 7 days).'
            : 'Could not reach the CodePair server. Is it running?'}
        </p>
        <Link href="/" className="mt-6 inline-block text-sm text-accent hover:underline">
          ← Back to home
        </Link>
      </CenterCard>
    );
  }

  if (phase === 'name') {
    return (
      <CenterCard>
        <Logo />
        <h1 className="mt-6 text-lg font-semibold">Join the interview</h1>
        <p className="mt-1 text-sm text-muted">Others will see this name next to your cursor.</p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const clean = name.trim().slice(0, 24);
            if (!clean) return;
            saveName(clean);
            setName(clean);
            setPhase('ready');
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name"
            maxLength={24}
            className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm outline-none placeholder:text-faint focus:border-accent"
          />
          <button className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white transition hover:bg-accent-strong">
            Join room
          </button>
        </form>
      </CenterCard>
    );
  }

  if (!session) return <div className="grid h-screen place-items-center text-sm text-faint">Connecting…</div>;
  return <Workspace roomId={roomId} session={session} />;
}

function Workspace({ roomId, session }: { roomId: string; session: Session }) {
  const { doc, provider, me, interviewerKey } = session;
  // The three shared structures (same names as in server/src/sync.ts).
  const ytext = useMemo(() => doc.getText('code'), [doc]);
  const state = useMemo(() => doc.getMap<unknown>('state'), [doc]);
  const chat = useMemo(() => doc.getArray<ChatMessage>('chat'), [doc]);

  const language = useMapValue<Language>(state, 'language') ?? 'python';
  const question = useMapValue<Question>(state, 'question');
  const run = useMapValue<RunState>(state, 'run');
  const participants = useParticipants(provider.awareness);

  const [connected, setConnected] = useState(provider.wsconnected);
  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => setConnected(status === 'connected');
    provider.on('status', onStatus);
    // The socket may have opened before this listener was attached.
    setConnected(provider.wsconnected);
    return () => provider.off('status', onStatus);
  }, [provider]);

  const [leftTab, setLeftTab] = useState<'problem' | 'interviewer'>('problem');
  const [starting, setStarting] = useState(false); // between the click and the server's "running"
  const [runError, setRunError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const running = starting || run?.status === 'running';

  const runCode = async () => {
    if (running) return;
    setStarting(true);
    setRunError(null);
    try {
      // The result is not read from this response: the server writes it into
      // the shared document, which updates `run` for everyone, including us.
      await api(`/api/rooms/${roomId}/run`, { method: 'POST', body: { name: me.name } });
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const copyInvite = async () => {
    // The address bar never contains the interviewer key (see takeInterviewerKey).
    await navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-screen flex-col">
      {/* ---- top bar ---- */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <Logo />
        <span className="flex items-center gap-2 rounded-md bg-raised px-2 py-1 font-mono text-xs text-muted">
          <span
            title={connected ? 'Connected' : 'Reconnecting…'}
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-ok' : 'animate-pulse bg-warn'}`}
          />
          {roomId}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={language}
            onChange={(event) => state.set('language', event.target.value)}
            aria-label="Language"
            className="rounded-md border border-line bg-raised px-2 py-1.5 text-xs outline-none focus:border-accent"
          >
            {LANGUAGES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            onClick={runCode}
            disabled={running}
            className="flex items-center gap-1.5 rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas transition hover:brightness-110 disabled:opacity-50"
          >
            <span className="text-[9px]">▶</span>
            {running ? 'Running…' : 'Run'}
          </button>
        </div>

        <div className="flex items-center -space-x-1.5 pl-2">
          {participants.map((person) => (
            <span
              key={person.clientId}
              title={`${person.name}${person.isMe ? ' (you)' : ''} · ${person.role}`}
              className="grid h-7 w-7 place-items-center rounded-full border-2 border-panel text-[11px] font-bold text-canvas"
              style={{ background: person.color }}
            >
              {person.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
        <button
          onClick={copyInvite}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-ink"
        >
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <Link
          href={`/replay/${roomId}`}
          target="_blank"
          className="rounded-md border border-line px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-ink"
        >
          Replay
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- left: problem / interviewer ---- */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-panel">
          <nav className="flex h-9 shrink-0 border-b border-line text-xs">
            {(['problem', ...(interviewerKey ? ['interviewer'] : [])] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setLeftTab(tab as typeof leftTab)}
                className={`border-b-2 px-4 font-semibold tracking-wide uppercase transition ${
                  leftTab === tab ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {tab}
              </button>
            ))}
          </nav>
          {/* Both tabs stay mounted (one hidden) so unsaved notes survive a tab switch. */}
          <div className={`min-h-0 flex-1 ${leftTab === 'problem' ? '' : 'hidden'}`}>
            <ProblemPanel question={question} isInterviewer={!!interviewerKey} />
          </div>
          {interviewerKey && (
            <div className={`min-h-0 flex-1 ${leftTab === 'interviewer' ? '' : 'hidden'}`}>
              <InterviewerPanel roomId={roomId} interviewerKey={interviewerKey} currentQuestionId={question?.id} />
            </div>
          )}
        </aside>

        {/* ---- centre: editor over console ---- */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CodeEditor language={language} ytext={ytext} awareness={provider.awareness} onRun={runCode} />
          </div>
          <div className="h-[32%] min-h-[140px] shrink-0 border-t border-line">
            <OutputConsole run={run} error={runError} />
          </div>
        </main>

        {/* ---- right: people + chat ---- */}
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel">
          <header className="flex h-9 shrink-0 items-center border-b border-line px-4 text-xs font-semibold tracking-wide text-muted uppercase">
            In the room · {participants.length}
          </header>
          <ul className="shrink-0 space-y-2 border-b border-line p-4">
            {participants.map((person) => (
              <li key={person.clientId} className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 rounded-full" style={{ background: person.color }} />
                <span className="truncate">
                  {person.name}
                  {person.isMe && <span className="text-faint"> (you)</span>}
                </span>
                <span className="ml-auto text-[10px] tracking-wide text-faint uppercase">{person.role}</span>
              </li>
            ))}
          </ul>
          <header className="flex h-9 shrink-0 items-center border-b border-line px-4 text-xs font-semibold tracking-wide text-muted uppercase">
            Chat
          </header>
          <ChatPanel chat={chat} me={me} />
        </aside>
      </div>
    </div>
  );
}
