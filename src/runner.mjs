import { spawn } from 'node:child_process';

const TAIL = 4000;

function pipeLines(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => buffer && onLine(buffer));
}

// Run a shell command to completion (install, rebuild), keeping the output tail.
export function runCommand(command, cwd, onLine = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (line) => {
      output = (output + line + '\n').slice(-TAIL);
      onLine(line);
    };
    pipeLines(child.stdout, collect);
    pipeLines(child.stderr, collect);
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

// Supervises the long-running app. It runs in its own process group so the
// whole tree (npm -> vite, cargo -> binary) stops together, and restarts with
// backoff if it crashes.
export class AppRunner {
  constructor(command, cwd, { onLine = () => {}, onState = () => {} } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.onLine = onLine;
    this.onState = onState;
    this.child = null;
    this.stopping = false;
    this.backoff = 1000;
    this.restartTimer = null;
  }

  start() {
    if (!this.command || this.child || this.closed) return;
    this.stopping = false;
    const startedAt = Date.now();
    const child = spawn(this.command, { cwd: this.cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    pipeLines(child.stdout, this.onLine);
    pipeLines(child.stderr, this.onLine);
    this.onState({ state: 'running', pid: child.pid });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      if (Date.now() - startedAt > 30000) this.backoff = 1000;
      this.onState({ state: 'crashed', code, signal, restartInMs: this.backoff });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopping = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = (signal) => {
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {}
      };
      const timer = setTimeout(() => kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        this.onState({ state: 'stopped' });
        resolve();
      });
      kill('SIGTERM');
    });
  }

  async restart() {
    await this.stop();
    this.backoff = 1000;
    this.start();
  }
}
