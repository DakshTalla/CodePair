// Everything the browser needs to talk to the server, plus the shared types.

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:4100';
export const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';

export type Language = 'python' | 'javascript' | 'cpp';

export const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'python', label: 'Python 3' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'cpp', label: 'C++ 17' },
];

// What the server writes into the shared `state` map under "run".
export interface RunState {
  status: 'running' | 'ok' | 'error' | 'timeout' | 'oom' | 'output_limit';
  by: string;
  language: Language;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timeMs?: number;
  at?: number;
}

export interface Question {
  id: string;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topics: string[];
  statement: string;
  hints?: string; // only present for the interviewer
}

export interface ChatMessage {
  name: string;
  color: string;
  text: string;
  at: number;
}

export interface LogEntry {
  t: number;
  u: string; // base64 Yjs update
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// One fetch wrapper: JSON in, JSON out, errors as exceptions.
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; interviewerKey?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.interviewerKey) headers['x-interviewer-key'] = options.interviewerKey;
  const res = await fetch(SERVER_URL + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

// ---- small pieces of per-browser state ----

const USER_COLORS = ['#8b7cff', '#3ecf8e', '#f5b84b', '#f2647a', '#4cc2ff', '#ff8f5a', '#d77cff', '#7bd6c4'];

export const randomColor = () => USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

export function loadName(): string {
  return localStorage.getItem('codepair:name') ?? '';
}

export function saveName(name: string): void {
  localStorage.setItem('codepair:name', name);
}

// The interviewer key arrives once in the URL fragment (#key=...) and is then
// kept in localStorage.
// WHY the fragment: browsers never send it to any server, so the key does not
// end up in access logs. WHY it is then removed from the address bar: so the
// interviewer can copy the URL to the candidate without leaking the key.
export function takeInterviewerKey(roomId: string): string | null {
  const storageKey = `codepair:key:${roomId}`;
  const match = /^#key=([\w-]+)$/.exec(window.location.hash);
  if (match) {
    localStorage.setItem(storageKey, match[1]);
    history.replaceState(null, '', window.location.pathname);
  }
  return localStorage.getItem(storageKey);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
