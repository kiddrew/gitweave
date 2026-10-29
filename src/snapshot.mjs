import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY, git, out, refSafe } from './git.mjs';

// Capture a worktree's current files (including uncommitted and untracked,
// excluding ignored) as a commit, without touching its branch, index or stash.
// A private index per lane keeps git's stat cache, so repeat snapshots are cheap.
export async function snapshotWorktree(repo, lane, previous) {
  const indexDir = join(repo.stateDir, 'index');
  if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
  const env = { GIT_INDEX_FILE: join(indexDir, `${refSafe(lane.name).replace(/\//g, '__')}.index`) };
  const cwd = lane.path;

  const head = await out(['rev-parse', 'HEAD'], { cwd });
  if (!existsSync(env.GIT_INDEX_FILE)) await git(['read-tree', head], { cwd, env });
  await git(['add', '--all', '--', '.'], { cwd, env });
  const tree = await out(['write-tree'], { cwd, env });

  if (previous && previous.tree === tree && previous.head === head) return previous;
  const headTree = await out(['rev-parse', `${head}^{tree}`], { cwd });
  const commit = tree === headTree
    ? head
    : await out(['commit-tree', tree, '-p', head, '-m', `lanes snapshot: ${lane.name}`], { cwd, env: IDENTITY });
  await git(['update-ref', `refs/lanes/snap/${refSafe(lane.name)}`, commit], { cwd: repo.main });
  return { head, tree, commit };
}

export async function resolveRemote(repo, lane) {
  const commit = await out(['rev-parse', `${lane.ref}^{commit}`], { cwd: repo.main });
  return { head: commit, tree: null, commit };
}
