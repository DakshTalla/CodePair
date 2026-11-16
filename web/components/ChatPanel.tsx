'use client';

// Room chat. Messages live in a Y.Array inside the shared document, so chat
// needs no extra server code: it syncs, persists and replays like the code.

import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { ChatMessage } from '@/lib/api';
import { useArray } from '@/lib/hooks';

interface Props {
  chat: Y.Array<ChatMessage>;
  me: { name: string; color: string };
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      {messages.length === 0 && <p className="text-xs text-faint">No messages yet.</p>}
      {messages.map((message, i) => (
        <div key={i} className="text-sm">
          <div className="flex items-baseline gap-2">
            <span className="font-medium" style={{ color: message.color }}>
              {message.name}
            </span>
            <span className="text-[10px] text-faint">
              {new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <p className="break-words whitespace-pre-wrap text-ink/90">{message.text}</p>
        </div>
      ))}
      <div ref={bottom} />
    </div>
  );
}

export default function ChatPanel({ chat, me }: Props) {
  const messages = useArray(chat);
  const [draft, setDraft] = useState('');

  const send = () => {
    const text = draft.trim().slice(0, 500);
    if (!text) return;
    chat.push([{ name: me.name, color: me.color, text, at: Date.now() }]);
    setDraft('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageList messages={messages} />
      <form
        className="border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message the room…"
          maxLength={500}
          className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent"
        />
      </form>
    </div>
  );
}
