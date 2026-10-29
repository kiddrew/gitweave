import { spawn } from 'node:child_process';

// Commits made by gitweave never depend on the user's git identity being configured.
export const IDENTITY = {
  GIT_AUTHOR_NAME: 'gitweave',
  GIT_AUTHOR_EMAIL: 'gitweave@localhost',
  GIT_COMMITTER_NAME: 'gitweave',
  GIT_COMMITTER_EMAIL: 'gitweave@localhost',
};

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.code = code;
    this.stderr = stderr;
  }
}

function baseEnv() {
  const env = { ...process.env };
  // A parent hook or tool may point git elsewhere; gitweave always resolves from cwd.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

export function git(args, { cwd, env, ok = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...baseEnv(), ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (ok.includes(code) ? resolve({ code, stdout, stderr }) : reject(new GitError(args, code, stderr))));
  });
}

export async function out(args, opts) {
  return (await git(args, opts)).stdout.trim();
}

export async function checkGitVersion() {
  const version = await out(['version']);
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38)) {
    throw new Error(`gitweave needs git 2.38 or newer for in-memory merges (found: ${version}).`);
  }
}

// Turn a lane name into something valid inside a ref path.
export function refSafe(name) {
  const cleaned = name
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/\/\.+/g, '/-')
    .replace(/\/+/g, '/')
    .replace(/\.lock(\/|$)/g, '-lock$1')
    .replace(/^[./-]+|[./]+$/g, '');
  return cleaned || 'lane';
}
