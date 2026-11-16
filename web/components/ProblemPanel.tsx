'use client';

// The problem statement everyone in the room sees.

import type { Question } from '@/lib/api';

const DIFFICULTY: Record<Question['difficulty'], string> = {
  Easy: 'text-ok border-ok/40 bg-ok/10',
  Medium: 'text-warn border-warn/40 bg-warn/10',
  Hard: 'text-bad border-bad/40 bg-bad/10',
};

export function DifficultyBadge({ level }: { level: Question['difficulty'] }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${DIFFICULTY[level]}`}>
      {level}
    </span>
  );
}

export default function ProblemPanel({ question, isInterviewer }: { question?: Question; isInterviewer: boolean }) {
  if (!question) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-3xl text-faint">{'{ }'}</div>
        <p className="text-sm text-muted">No problem selected yet.</p>
        <p className="text-xs text-faint">
          {isInterviewer
            ? 'Pick one from the Interviewer tab. It appears here for everyone.'
            : 'The interviewer will choose one. You can start typing in the editor meanwhile.'}
        </p>
      </div>
    );
  }
  return (
    <article className="h-full overflow-auto p-5">
      <h2 className="text-lg font-semibold">{question.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DifficultyBadge level={question.difficulty} />
        {question.topics.map((topic) => (
          <span key={topic} className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted">
            {topic}
          </span>
        ))}
      </div>
      {/* The statement is plain text; pre-wrap keeps its line breaks and the
          indentation of the examples. Rendering it as text (not HTML) also
          means nothing in it can ever run as script. */}
      <p className="mt-4 text-sm leading-relaxed whitespace-pre-wrap text-ink/90">{question.statement}</p>
    </article>
  );
}
