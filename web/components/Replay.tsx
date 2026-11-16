'use client';

// Session replay with a timeline scrubber.
//
// How it works: the server stored every Yjs update with a timestamp. Position
// N on the timeline means "an empty document with the first N updates
// applied". Because code, output and chat all live in the same document, one
// slider replays all three together.

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { api, ApiError, formatClock, type ChatMessage, type Language, type LogEntry, type Question, type RunState } from '@/lib/api';
import { MessageList } from './ChatPanel';
import CodeEditor from './CodeEditor';
import OutputConsole from './OutputConsole';
import { Logo } from './Room';

interface Recorded {
  t: number;
  update: Uint8Array;
}

// What the screen shows at one timeline position.
interface Frame {
  code: string;
  language: Language;
  question?: Question;
  run?: RunState;
  chat: ChatMessage[];
  caret: number | null; // where the most recent keystroke happened
}

const SPEEDS = [1, 2, 4, 8];
const MAX_GAP_MS = 1500; // long pauses in the recording are shortened to this

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

export default function Replay({ roomId }: { roomId: string }) {
  const [log, setLog] = useState<Recorded[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0); // number of updates applied, 0..log.length
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);

  useEffect(() => {
    api<LogEntry[]>(`/api/rooms/${roomId}/recording`)
      .then((entries) => setLog(entries.map((entry) => ({ t: entry.t, update: decodeBase64(entry.u) }))))
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 404 ? 'Room not found.' : 'Could not load the recording.'),
      );
  }, [roomId]);

  // Timeline markers: one pass over the log to find where code was run.
  const runMarkers = useMemo(() => {
    const markers: Array<{ index: number; ok: boolean }> = [];
    if (!log) return markers;
    const doc = new Y.Doc();
    const state = doc.getMap<RunState>('state');
    let position = 0;
    state.observe((event) => {
      const run = state.get('run');
      if (event.keysChanged.has('run') && run && run.status !== 'running') {
        markers.push({ index: position, ok: run.status === 'ok' });
      }
    });
    for (const entry of log) {
      position++;
      Y.applyUpdate(doc, entry.update);
    }
    doc.destroy();
    return markers;
  }, [log]);

  // The replay document and how many updates it currently holds.
  const player = useRef({ doc: new Y.Doc(), applied: 0, caret: null as number | null });
  const [frame, setFrame] = useState<Frame>({ code: '', language: 'python', chat: [], caret: null });

  useEffect(() => {
    if (!log) return;
    const p = player.current;
    // Moving forward: apply only the new updates. Moving backward: CRDT
    // updates cannot be "un-applied", so start again from an empty document.
    if (index < p.applied) {
      p.doc.destroy();
      p.doc = new Y.Doc();
      p.applied = 0;
      p.caret = null;
    }
    const text = p.doc.getText('code');
    const trackCaret = (event: Y.YTextEvent) => {
      let at = 0;
      for (const step of event.delta) {
        if (step.retain !== undefined) at += step.retain;
        else if (typeof step.insert === 'string') p.caret = at += step.insert.length;
        else if (step.delete !== undefined) p.caret = at;
      }
    };
    text.observe(trackCaret);
    while (p.applied < index) Y.applyUpdate(p.doc, log[p.applied++].update);
    text.unobserve(trackCaret);

    const state = p.doc.getMap('state');
    setFrame({
      code: text.toString(),
      language: (state.get('language') as Language) ?? 'python',
      question: state.get('question') as Question | undefined,
      run: state.get('run') as RunState | undefined,
      chat: p.doc.getArray<ChatMessage>('chat').toArray(),
      caret: index === 0 ? null : p.caret,
    });
  }, [log, index]);

  // Playback: schedule the next step after the same pause as in the recording,
  // divided by the speed.
  useEffect(() => {
    if (!playing || !log) return;
    if (index >= log.length) return setPlaying(false);
    const gap = index === 0 ? 0 : log[index].t - log[index - 1].t;
    const timer = setTimeout(() => setIndex((i) => i + 1), Math.min(gap, MAX_GAP_MS) / speed);
    return () => clearTimeout(timer);
  }, [playing, index, speed, log]);

  const total = log?.length ?? 0;
  const togglePlay = () => {
    if (index >= total) setIndex(0); // at the end: start over
    setPlaying((p) => !p);
  };

  // Keyboard: space = play/pause, arrows = one edit back/forward.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.code === 'ArrowRight') setIndex((i) => Math.min(total, i + 1));
      else if (event.code === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <div className="grid h-screen place-items-center text-sm text-muted">{error}</div>;
  if (!log) return <div className="grid h-screen place-items-center text-sm text-faint">Loading recording…</div>;

  const startTime = log[0]?.t ?? 0;
  const elapsed = index === 0 ? 0 : log[index - 1].t - startTime;
  const duration = total === 0 ? 0 : log[total - 1].t - startTime;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <Logo />
        <span className="rounded-md bg-accent/15 px-2 py-1 text-xs font-medium text-accent">Replay</span>
        <span className="font-mono text-xs text-muted">{roomId}</span>
        {frame.question && <span className="truncate text-sm text-muted">· {frame.question.title}</span>}
        <Link
          href={`/room/${roomId}`}
          className="ml-auto rounded-md border border-line px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-ink"
        >
          Open live room
        </Link>
      </header>

      {total === 0 ? (
        <div className="grid flex-1 place-items-center text-sm text-muted">Nothing has been recorded in this room yet.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <CodeEditor language={frame.language} value={frame.code} caretOffset={frame.caret} />
            </div>
            <div className="h-[30%] min-h-[130px] shrink-0 border-t border-line">
              <OutputConsole run={frame.run} replay />
            </div>
          </main>
          <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel">
            <header className="flex h-9 shrink-0 items-center border-b border-line px-4 text-xs font-semibold tracking-wide text-muted uppercase">
              Chat at this moment
            </header>
            <MessageList messages={frame.chat} />
          </aside>
        </div>
      )}

      {/* ---- timeline ---- */}
      {total > 0 && (
        <footer className="flex h-16 shrink-0 items-center gap-4 border-t border-line bg-panel px-4">
          <button
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-sm text-white transition hover:bg-accent-strong"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="w-28 shrink-0 font-mono text-xs text-muted">
            {formatClock(elapsed)} / {formatClock(duration)}
          </span>
          <div className="relative flex flex-1 items-center">
            <input
              type="range"
              className="timeline w-full"
              aria-label="Timeline"
              min={0}
              max={total}
              value={index}
              style={{ '--progress': `${(index / total) * 100}%` } as React.CSSProperties}
              onChange={(event) => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
            />
            {/* dots where the code was run: green = exit 0, red = anything else */}
            {runMarkers.map((marker) => (
              <button
                key={marker.index}
                title={`Code run (${marker.ok ? 'ok' : 'failed'})`}
                onClick={() => {
                  setPlaying(false);
                  setIndex(marker.index);
                }}
                className={`absolute top-[-10px] h-2 w-2 -translate-x-1/2 rounded-full ${marker.ok ? 'bg-ok' : 'bg-bad'}`}
                style={{ left: `${(marker.index / total) * 100}%` }}
              />
            ))}
          </div>
          <span className="w-32 shrink-0 text-right font-mono text-xs text-faint">
            edit {index} / {total}
          </span>
          <div className="flex shrink-0 overflow-hidden rounded-md border border-line text-xs">
            {SPEEDS.map((option) => (
              <button
                key={option}
                onClick={() => setSpeed(option)}
                className={`px-2 py-1 transition ${speed === option ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`}
              >
                {option}×
              </button>
            ))}
          </div>
        </footer>
      )}
    </div>
  );
}
