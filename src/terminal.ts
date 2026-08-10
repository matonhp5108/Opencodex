import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_SESSION_OUTPUT = 120_000;

export type TerminalShellConfig = {
  executable: string;
  args: string[];
  lineEnding: '\n' | '\r\n';
};

export function terminalShellConfig(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalShellConfig {
  if (platform === 'win32') {
    return { executable: env.ComSpec || 'cmd.exe', args: ['/d', '/q'], lineEnding: '\r\n' };
  }
  return { executable: env.SHELL || '/bin/sh', args: ['-i'], lineEnding: '\n' };
}

type TerminalSession = {
  name: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  baseOffset: number;
  exitCode?: number | null;
};

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  start(name: string, cwd: string, initialCommand?: string): string {
    const sessionName = this.normalizeName(name);
    const existing = this.sessions.get(sessionName);
    if (existing && existing.exitCode === undefined) throw new Error(`Terminal '${sessionName}' is already running.`);
    if (existing) this.sessions.delete(sessionName);
    const shell = terminalShellConfig();
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      stdio: 'pipe',
      windowsHide: true,
    });
    const session: TerminalSession = { name: sessionName, cwd, process: child, output: '', baseOffset: 0 };
    this.sessions.set(sessionName, session);
    const append = (chunk: Buffer) => this.append(session, chunk.toString());
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => this.append(session, `\n[terminal error] ${error.message}\n`));
    child.on('close', code => {
      session.exitCode = code;
      this.append(session, `\n[process exited with code ${code ?? 'unknown'}]\n`);
    });
    if (initialCommand?.trim()) child.stdin.write(`${initialCommand.trim()}${shell.lineEnding}`);
    return `Started persistent terminal '${sessionName}' in ${cwd}.`;
  }

  write(name: string, input: string): string {
    const session = this.running(name);
    session.process.stdin.write(input);
    return `Wrote ${input.length} characters to terminal '${session.name}'.`;
  }

  read(name: string, cursor = 0): { output: string; cursor: number; running: boolean; exitCode?: number | null } {
    const session = this.require(name);
    const absoluteEnd = session.baseOffset + session.output.length;
    const safeCursor = Math.max(session.baseOffset, Math.min(cursor, absoluteEnd));
    return {
      output: session.output.slice(safeCursor - session.baseOffset) || '(no new output)',
      cursor: absoluteEnd,
      running: session.exitCode === undefined,
      exitCode: session.exitCode,
    };
  }

  list(): Array<{ name: string; cwd: string; running: boolean; exitCode?: number | null }> {
    return [...this.sessions.values()].map(session => ({
      name: session.name,
      cwd: session.cwd,
      running: session.exitCode === undefined,
      exitCode: session.exitCode,
    }));
  }

  stop(name: string): string {
    const session = this.require(name);
    if (session.exitCode === undefined) session.process.kill('SIGTERM');
    return `Stopped terminal '${session.name}'.`;
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.exitCode === undefined) session.process.kill('SIGTERM');
    }
    this.sessions.clear();
  }

  private append(session: TerminalSession, text: string): void {
    session.output += text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    if (session.output.length > MAX_SESSION_OUTPUT) {
      const removed = session.output.length - MAX_SESSION_OUTPUT;
      session.output = session.output.slice(removed);
      session.baseOffset += removed;
    }
  }

  private normalizeName(name: string): string {
    const value = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!value) throw new Error('Terminal name cannot be empty.');
    return value.slice(0, 60);
  }

  private require(name: string): TerminalSession {
    const session = this.sessions.get(this.normalizeName(name));
    if (!session) throw new Error(`Terminal '${name}' does not exist.`);
    return session;
  }

  private running(name: string): TerminalSession {
    const session = this.require(name);
    if (session.exitCode !== undefined) throw new Error(`Terminal '${session.name}' has exited with code ${session.exitCode ?? 'unknown'}.`);
    return session;
  }
}
