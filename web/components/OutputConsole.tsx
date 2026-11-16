'use client';

// Shows the result of the last run. The data comes from the shared document,
// so every participant sees the same output at the same time.

import type { RunState } from '@/lib/api';

const STATUS: Record<RunState['status'], { label: string; className: string }> = {
  running: { label: 'Running', className: 'text-accent border-accent/40 bg-accent/10' },
  ok: { label: 'Finished', className: 'text-ok border-ok/40 bg-ok/10' },
  error: { label: 'Error', className: 'text-bad border-bad/40 bg-bad/10' },
  timeout: { label: 'Time limit exceeded', className: 'text-warn border-warn/40 bg-warn/10' },
  oom: { label: 'Memory limit exceeded', className: 'text-warn border-warn/40 bg-warn/10' },
  output_limit: { label: 'Output limit exceeded', className: 'text-warn border-warn/40 bg-warn/10' },
};

interface Props {
  run?: RunState;
  error?: string | null;
  replay?: boolean; // read-only view: there is no Run button to explain
}

export default function OutputConsole({ run, error, replay }: Props) {
  const status = run ? STATUS[run.status] : null;
  const empty = run && run.status !== 'running' && !run.stdout && !run.stderr;

  return (
    <section className="flex h-full flex-col bg-panel">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-4 text-xs">
        <span className="font-semibold tracking-wide text-muted uppercase">Output</span>
        {status && (
          <span className={`rounded-full border px-2 py-0.5 font-medium ${status.className}`}>
            {status.label}
          </span>
        )}
        {run && run.status !== 'running' && (
          <span className="ml-auto font-mono text-faint">
            {run.by} · {run.language} · {run.timeMs} ms
            {run.exitCode !== null && run.exitCode !== undefined && ` · exit ${run.exitCode}`}
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[13px] leading-relaxed">
        {error && <pre className="whitespace-pre-wrap text-bad">{error}</pre>}
        {!run && replay && <p className="text-faint">The code has not been run yet at this point.</p>}
        {!run && !error && !replay && (
          <p className="text-faint">
            Press <kbd className="rounded border border-line bg-raised px-1.5 py-0.5">Ctrl</kbd>{' '}
            <kbd className="rounded border border-line bg-raised px-1.5 py-0.5">Enter</kbd> or Run to
            execute the code in an isolated container.
          </p>
        )}
        {run?.status === 'running' && (
          <p className="animate-pulse text-muted">Running in sandbox (started by {run.by})…</p>
        )}
        {run?.stdout && <pre className="whitespace-pre-wrap text-ink">{run.stdout}</pre>}
        {run?.stderr && <pre className="whitespace-pre-wrap text-bad">{run.stderr}</pre>}
        {empty && <p className="text-faint">(the program printed nothing)</p>}
      </div>
    </section>
  );
}
