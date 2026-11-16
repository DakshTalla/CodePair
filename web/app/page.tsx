'use client';

// Landing page: create a room (you become the interviewer) or join one.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Logo } from '@/components/Room';
import { api } from '@/lib/api';

const FEATURES = [
  ['Live collaborative editor', 'Conflict-free editing on a CRDT (Yjs), with cursors and presence.'],
  ['Sandboxed execution', 'Python, JavaScript and C++ run in throwaway containers with no network.'],
  ['Keystroke replay', 'Scrub through the whole session afterwards, edit by edit.'],
  ['Interviewer tools', 'Question bank, private notes and a rating the candidate never sees.'],
];

export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const room = await api<{ roomId: string; interviewerKey: string }>('/api/rooms', { method: 'POST' });
      // The key travels in the URL fragment, which is never sent to a server.
      router.push(`/room/${room.roomId}#key=${room.interviewerKey}`);
    } catch {
      setError('Could not reach the server. Is it running?');
      setCreating(false);
    }
  };

  const join = (event: React.FormEvent) => {
    event.preventDefault();
    // Accept either a full invite link or just the room code.
    const id = code.trim().split('/').pop()?.split('#')[0];
    if (id) router.push(`/room/${id}`);
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* soft glow behind the hero */}
      <div className="pointer-events-none absolute top-[-300px] left-1/2 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-accent/15 blur-[120px]" />

      <header className="relative mx-auto flex max-w-5xl items-center px-6 py-6">
        <Logo />
      </header>

      <main className="relative mx-auto max-w-5xl px-6 pt-16 pb-24">
        <p className="mb-4 inline-block rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted">
          Real-time · CRDT · Docker sandbox
        </p>
        <h1 className="max-w-2xl text-5xl leading-[1.1] font-semibold tracking-tight">
          Coding interviews in a shared editor that{' '}
          <span className="bg-gradient-to-r from-accent to-[#4cc2ff] bg-clip-text text-transparent">
            runs the code
          </span>
          .
        </h1>
        <p className="mt-5 max-w-xl text-muted">
          Open a room, send the link, and write code together. Run it safely, chat, and replay the whole
          session keystroke by keystroke afterwards.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <button
            onClick={create}
            disabled={creating}
            className="rounded-lg bg-accent px-5 py-3 text-sm font-medium text-white shadow-lg shadow-accent/20 transition hover:bg-accent-strong disabled:opacity-60"
          >
            {creating ? 'Creating room…' : 'Start an interview'}
          </button>
          <form onSubmit={join} className="flex items-center gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste a room link or code"
              aria-label="Room link or code"
              className="w-64 rounded-lg border border-line bg-panel px-3 py-3 text-sm outline-none placeholder:text-faint focus:border-accent"
            />
            <button className="rounded-lg border border-line px-4 py-3 text-sm text-muted transition hover:border-accent hover:text-ink">
              Join
            </button>
          </form>
        </div>
        {error && <p className="mt-4 text-sm text-bad">{error}</p>}

        <div className="mt-20 grid gap-4 sm:grid-cols-2">
          {FEATURES.map(([title, text]) => (
            <div key={title} className="rounded-xl border border-line bg-panel p-5">
              <h2 className="text-sm font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted">{text}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
