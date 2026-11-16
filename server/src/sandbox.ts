// Runs untrusted code in a throwaway Docker container.
//
// Threat model: the code is written by a stranger and may be hostile. It could
// try to read the host's files, use the network, eat all CPU or memory, fork
// endlessly, fill the disk, or print gigabytes. Each `docker run` flag below
// blocks one of those. The honest limitation: containers share the host
// kernel, so a kernel exploit could still escape. Real products add a stronger
// layer (gVisor or Firecracker micro-VMs); see docs/STUDY_GUIDE.md.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { SANDBOX } from './config';

export type Language = 'python' | 'javascript' | 'cpp';

// How each language is saved and started inside the container.
const LANGUAGES: Record<Language, { file: string; run: string }> = {
  python: { file: 'main.py', run: 'python3 main.py' },
  javascript: { file: 'main.js', run: 'node main.js' },
  cpp: { file: 'main.cpp', run: 'g++ -O1 -o main main.cpp && ./main' },
};

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && value in LANGUAGES;

export interface RunResult {
  // ok: exit code 0.  error: non-zero exit (includes compile errors).
  // timeout / oom / output_limit: we killed it for breaking a limit.
  status: 'ok' | 'error' | 'timeout' | 'oom' | 'output_limit';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timeMs: number;
}

export interface Limits {
  timeoutMs: number;
  memory: string;
  cpus: string;
  pidsLimit: number;
  maxOutputBytes: number;
}

export class SandboxBusyError extends Error {}

let active = 0; // containers running right now

export function dockerArgs(name: string, lang: Language, limits: Limits): string[] {
  const { file, run } = LANGUAGES[lang];
  return [
    'run',
    '--rm', // throwaway: the container is deleted as soon as it exits
    '-i', // keep stdin open: that is how the code gets in
    '--name', name, // so the timeout can `docker kill` it by name
    '--network', 'none', // no network interface at all, only loopback
    '--memory', limits.memory,
    '--memory-swap', limits.memory, // same value = no swap, so the cap is real
    '--cpus', limits.cpus,
    '--pids-limit', String(limits.pidsLimit), // fork-bomb protection
    '--read-only', // the image's filesystem cannot be modified
    // The only writable place: a small in-memory disk. `exec` because the C++
    // binary is compiled into it; its size counts towards the memory limit.
    '--tmpfs', '/tmp:rw,exec,nosuid,size=32m,mode=1777',
    '--cap-drop', 'ALL', // drop every Linux capability (no raw sockets, mounts...)
    '--security-opt', 'no-new-privileges', // setuid binaries cannot elevate
    '--user', '1000:1000', // not root, even inside the container
    '--workdir', '/tmp',
    '--env', 'HOME=/tmp',
    SANDBOX.image,
    // WHY the code comes in on stdin instead of a mounted file: nothing from
    // the host filesystem is ever shared with the container.
    'sh', '-c', `cat > ${file} && ${run}`,
  ];
}

export function runCode(
  lang: Language,
  code: string,
  overrides: Partial<Limits> = {},
): Promise<RunResult> {
  const limits: Limits = { ...SANDBOX, ...overrides };
  // WHY a global cap: each run can use a full CPU and 256 MB, so unlimited
  // parallel runs would let users overload the host from outside the sandbox.
  if (active >= SANDBOX.maxConcurrent) {
    return Promise.reject(new SandboxBusyError('Too many programs are running, try again'));
  }
  active++;

  return new Promise((resolve) => {
    const name = `codepair-run-${randomBytes(6).toString('hex')}`;
    const started = Date.now();
    const child = spawn('docker', dockerArgs(name, lang, limits), { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let killedFor: 'timeout' | 'output_limit' | null = null;

    // `docker kill` sends SIGKILL to the container's processes. Killing only
    // the local `docker` CLI process would leave the container running.
    const kill = (reason: 'timeout' | 'output_limit') => {
      if (killedFor) return;
      killedFor = reason;
      execFile('docker', ['kill', name], { windowsHide: true }, () => {});
    };
    const timer = setTimeout(() => kill('timeout'), limits.timeoutMs);

    const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) return kill('output_limit');
      if (which === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    let finished = false;
    const finish = (exitCode: number | null, extraError = '') => {
      if (finished) return; // 'error' and 'close' can both fire
      finished = true;
      clearTimeout(timer);
      active--;
      let status: RunResult['status'];
      if (killedFor) status = killedFor;
      // 137 = 128 + SIGKILL(9). If we did not kill it, the kernel's
      // out-of-memory killer did, because the memory limit was hit.
      else if (exitCode === 137) status = 'oom';
      else status = exitCode === 0 ? 'ok' : 'error';
      resolve({ status, stdout, stderr: stderr + extraError, exitCode, timeMs: Date.now() - started });
    };
    child.on('close', (exitCode) => finish(exitCode));
    child.on('error', (err) => finish(null, `Could not start Docker: ${err.message}`));

    child.stdin.on('error', () => {}); // container died before reading the code
    child.stdin.end(code, 'utf8');
  });
}
