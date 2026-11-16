// Sandbox limits: each test runs a hostile or greedy program in a real
// container and checks that the matching limit stops it.
// Needs Docker and the codepair-sandbox image; skipped when they are missing.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SANDBOX } from '../src/config';
import { dockerArgs, runCode, SandboxBusyError } from '../src/sandbox';

function sandboxImageExists(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', SANDBOX.image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('docker run flags', () => {
  it('always include the isolation flags', () => {
    const args = dockerArgs('name', 'python', SANDBOX).join(' ');
    for (const flag of [
      '--rm',
      '--network none',
      '--memory 256m',
      '--memory-swap 256m',
      '--cpus 1',
      '--pids-limit 64',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--user 1000:1000',
    ]) {
      expect(args).toContain(flag);
    }
  });
});

describe.skipIf(!sandboxImageExists())('sandbox', () => {
  it('runs Python', async () => {
    const result = await runCode('python', 'print(sum(range(10)))');
    expect(result).toMatchObject({ status: 'ok', stdout: '45\n', exitCode: 0 });
  });

  it('runs JavaScript', async () => {
    const result = await runCode('javascript', 'console.log([1, 2, 3].map((x) => x * 2).join(","))');
    expect(result).toMatchObject({ status: 'ok', stdout: '2,4,6\n' });
  });

  it('compiles and runs C++', async () => {
    const code = '#include <iostream>\nint main() { std::cout << 6 * 7 << std::endl; return 0; }';
    const result = await runCode('cpp', code);
    expect(result).toMatchObject({ status: 'ok', stdout: '42\n' });
  });

  it('reports a C++ compile error', async () => {
    const result = await runCode('cpp', 'int main() { return undefined_name; }');
    expect(result.status).toBe('error');
    expect(result.stderr).toContain('undefined_name');
  });

  it('reports a runtime error with its exit code', async () => {
    const result = await runCode('python', 'import sys\nprint("before")\nsys.exit(3)');
    expect(result).toMatchObject({ status: 'error', stdout: 'before\n', exitCode: 3 });
  });

  it('time limit: kills an infinite loop', async () => {
    const result = await runCode('python', 'while True:\n    pass', { timeoutMs: 2000 });
    expect(result.status).toBe('timeout');
    expect(result.timeMs).toBeGreaterThanOrEqual(2000);
    expect(result.timeMs).toBeLessThan(6000); // killed promptly, not left running
  });

  it('memory limit: a program that allocates without end is OOM-killed', async () => {
    const code = 'chunks = []\nwhile True:\n    chunks.append("x" * 1_000_000)';
    const result = await runCode('python', code, { memory: '64m' });
    expect(result.status).toBe('oom');
    expect(result.exitCode).toBe(137);
  });

  it('process limit: a fork bomb cannot create unlimited processes', async () => {
    const code = [
      'import os, time',
      'children = 0',
      'try:',
      '    while True:',
      '        if os.fork() == 0:',
      '            time.sleep(30)  # each child stays alive, holding a process slot',
      '            os._exit(0)',
      '        children += 1',
      'except OSError:',
      '    print("fork failed after", children, flush=True)',
    ].join('\n');
    const result = await runCode('python', code, { timeoutMs: 8000 });
    const match = /fork failed after (\d+)/.exec(result.stdout);
    expect(match, result.stdout + result.stderr).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(SANDBOX.pidsLimit);
  });

  it('output limit: kills a program that prints without end', async () => {
    const result = await runCode('python', 'while True:\n    print("x" * 1000)');
    expect(result.status).toBe('output_limit');
    expect(result.stdout.length).toBeLessThanOrEqual(SANDBOX.maxOutputBytes);
  });

  it('no network: an outbound connection fails', async () => {
    const code = [
      'import socket',
      'try:',
      '    socket.create_connection(("1.1.1.1", 80), timeout=3)',
      '    print("CONNECTED")',
      'except OSError as e:',
      '    print("blocked:", e)',
    ].join('\n');
    const result = await runCode('python', code);
    expect(result.stdout).toContain('blocked:');
    expect(result.stdout).not.toContain('CONNECTED');
  });

  it('read-only filesystem and non-root user', async () => {
    const code = [
      'import os',
      'print("uid", os.getuid())',
      'try:',
      '    open("/etc/hacked", "w")',
      '    print("WROTE")',
      'except OSError as e:',
      '    print("blocked:", e.strerror)',
    ].join('\n');
    const result = await runCode('python', code);
    expect(result.stdout).toContain('uid 1000');
    expect(result.stdout).toContain('blocked:');
    expect(result.stdout).not.toContain('WROTE');
  });

  it('refuses to start more than the allowed number of containers at once', async () => {
    const slow = 'import time\ntime.sleep(1)';
    const runs = Array.from({ length: SANDBOX.maxConcurrent }, () => runCode('python', slow));
    await expect(runCode('python', slow)).rejects.toBeInstanceOf(SandboxBusyError);
    const results = await Promise.all(runs);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('leaves no container behind', async () => {
    await runCode('python', 'while True:\n    pass', { timeoutMs: 1000 });
    const left = execFileSync('docker', ['ps', '-aq', '--filter', 'name=codepair-run-']).toString().trim();
    expect(left).toBe('');
  });
});
