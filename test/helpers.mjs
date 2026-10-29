import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, out } from '../src/git.mjs';
import { openRepo, realpathMaybe } from '../src/repo.mjs';
import { loadConfig } from '../src/config.mjs';

export const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
export const read = (path) => readFileSync(path, 'utf8');

// A fresh repo with a committed base, inside its own temp folder so the
// preview worktree (a sibling of the main worktree) is cleaned up with it.
export async function makeRepo(files = { 'app.txt': 'one\ntwo\nthree\n', '.gitignore': 'node_modules/\n' }) {
  const root = realpathMaybe(mkdtempSync(join(tmpdir(), 'gitweave-test-')));
  const main = join(root, 'repo');
  mkdirSync(main);
  await git(['init', '-q', '-b', 'main'], { cwd: main });
  await git(['config', 'user.name', 'Test'], { cwd: main });
  await git(['config', 'user.email', 'test@example.com'], { cwd: main });
  for (const [name, text] of Object.entries(files)) write(join(main, name), text);
  await git(['add', '-A'], { cwd: main });
  await git(['commit', '-q', '-m', 'base'], { cwd: main });
  return { root, main, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function addWorktree(main, name) {
  const path = join(dirname(main), name);
  await git(['worktree', 'add', '-q', '-b', name, path, 'main'], { cwd: main });
  return path;
}

export async function setup(files, overrides = {}) {
  const fixture = await makeRepo(files);
  const repo = await openRepo(fixture.main);
  const config = await loadConfig(repo, { settleMs: 100, pollMs: 200, ...overrides });
  return { ...fixture, repo, config };
}

// Everything git could change in a worktree: status, index, HEAD and refs.
export async function fingerprint(path) {
  return {
    status: await out(['status', '--porcelain=v2', '--untracked-files=all'], { cwd: path }),
    index: await out(['ls-files', '--stage', '--debug'], { cwd: path }),
    head: await out(['rev-parse', 'HEAD'], { cwd: path }),
    branches: await out(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash'], { cwd: path }),
  };
}

export async function waitFor(check, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((r) => setTimeout(r, 50));
  }
}
