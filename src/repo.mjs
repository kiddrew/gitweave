import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checkGitVersion, out } from './git.mjs';

export function realpathMaybe(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function listWorktrees(cwd) {
  const text = await out(['worktree', 'list', '--porcelain'], { cwd });
  const worktrees = [];
  for (const block of text.split(/\n\s*\n/)) {
    const wt = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') wt.path = value;
      else if (key === 'HEAD') wt.head = value;
      else if (key === 'branch') wt.branch = value;
      else if (key === 'detached') wt.detached = true;
      else if (key === 'bare') wt.bare = true;
      else if (key === 'prunable') wt.prunable = true;
    }
    if (wt.path) worktrees.push(wt);
  }
  return worktrees;
}

export async function openRepo(cwd) {
  await checkGitVersion();
  await out(['rev-parse', '--show-toplevel'], { cwd }).catch(() => {
    throw new Error('Not inside a git worktree.');
  });
  const commonDir = await out(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  const worktrees = await listWorktrees(cwd);
  // `git worktree list` always lists the main worktree first.
  const main = worktrees[0]?.bare ? null : worktrees[0]?.path;
  if (!main) throw new Error('lanes needs a repository with a main (non-bare) worktree.');
  const stateDir = join(commonDir, 'lanes');
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  return { main, commonDir, stateDir };
}
