'use client';

// Visible only to the interviewer: question bank, private notes and a rating.
// None of this is in the shared document. It is loaded and saved over REST
// with the interviewer key, so it never reaches the candidate's browser.

import { useEffect, useRef, useState } from 'react';
import { api, type Question } from '@/lib/api';
import { DifficultyBadge } from './ProblemPanel';

interface Props {
  roomId: string;
  interviewerKey: string;
  currentQuestionId?: string;
}

export default function InterviewerPanel({ roomId, interviewerKey, currentQuestionId }: Props) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [notes, setNotes] = useState('');
  const [rating, setRating] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const loaded = useRef(false);
  const base = `/api/rooms/${roomId}`;

  useEffect(() => {
    api<Question[]>(`${base}/questions`, { interviewerKey }).then(setQuestions).catch(() => {});
    api<{ notes: string; rating: number }>(`${base}/interview`, { interviewerKey })
      .then((data) => {
        setNotes(data.notes);
        setRating(data.rating);
      })
      .catch(() => {})
      .finally(() => (loaded.current = true));
  }, [base, interviewerKey]);

  // Autosave: wait until typing has paused for 600 ms, then save once.
  // (Called "debouncing": it avoids one request per keystroke.)
  const dirty = useRef(false);
  useEffect(() => {
    if (!loaded.current || !dirty.current) return;
    setSaveState('saving');
    const timer = setTimeout(() => {
      api(`${base}/interview`, { method: 'PUT', body: { notes, rating }, interviewerKey })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('failed'));
    }, 600);
    return () => clearTimeout(timer);
  }, [notes, rating, base, interviewerKey]);

  const edit = (change: () => void) => {
    dirty.current = true;
    change();
  };

  const selectQuestion = (questionId: string) =>
    api(`${base}/question`, { method: 'POST', body: { questionId }, interviewerKey }).catch(() => {});

  const current = questions.find((q) => q.id === currentQuestionId);

  return (
    <div className="h-full space-y-6 overflow-auto p-5">
      <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
        Private to you. The candidate cannot see this tab.
      </p>

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Question bank</h3>
        <ul className="space-y-1">
          {questions.map((question) => {
            const active = question.id === currentQuestionId;
            return (
              <li key={question.id}>
                <button
                  onClick={() => selectQuestion(question.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                    active ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-raised'
                  }`}
                >
                  <span className="truncate">{question.title}</span>
                  <DifficultyBadge level={question.difficulty} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {current?.hints && (
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">What to look for</h3>
          <p className="rounded-lg bg-raised p-3 text-xs leading-relaxed whitespace-pre-wrap text-ink/80">
            {current.hints}
          </p>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Rating</h3>
          <span className="text-[11px] text-faint">
            {{ idle: '', saving: 'Saving…', saved: 'Saved', failed: 'Could not save' }[saveState]}
          </span>
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              role="radio"
              aria-checked={rating === star}
              aria-label={`${star} of 5`}
              // Clicking the current rating again clears it.
              onClick={() => edit(() => setRating(rating === star ? 0 : star))}
              className={`text-2xl transition hover:scale-110 ${star <= rating ? 'text-warn' : 'text-line'}`}
            >
              ★
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Notes</h3>
        <textarea
          value={notes}
          onChange={(event) => edit(() => setNotes(event.target.value))}
          placeholder="Approach, communication, bugs found, follow-ups asked…"
          rows={8}
          className="w-full resize-y rounded-lg border border-line bg-raised p-3 text-sm leading-relaxed outline-none placeholder:text-faint focus:border-accent"
        />
      </section>
    </div>
  );
}
