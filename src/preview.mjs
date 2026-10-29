import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git, out } from './git.mjs';
import { listWorktrees, realpathMaybe } from './repo.mjs';

export async function ensurePreview(repo, config, startCommit) {
  const target = realpathMaybe(config.previewPath);
  const worktrees = await listWorktrees(repo.main);
  if (worktrees.some((wt) => realpathMaybe(wt.path) === target)) return { created: false };
  if (existsSync(config.previewPath)) {
    throw new Error(`${config.previewPath} exists but is not a worktree of this repository. Move it or set "previewPath".`);
  }
  mkdirSync(dirname(config.previewPath), { recursive: true });
  await git(['worktree', 'add', '--detach', '--quiet', config.previewPath, startCommit], { cwd: repo.main });
  return { created: true };
}

// Untracked local files the app needs (like .env, or pnpm's build approvals in
// an uncommitted pnpm-workspace.yaml) are copied from the main worktree, since
// they never travel through git. A name the merge tracks is left to git.
export async function copyLocalFiles(repo, config) {
  const copied = [];
  for (const name of config.copy) {
    const from = join(repo.main, name);
    const to = join(config.previewPath, name);
    if (!existsSync(from)) continue;
    const tracked = await git(['ls-files', '--error-unmatch', '--', name], { cwd: config.previewPath, ok: [0, 1] });
    if (tracked.code === 0) continue;
    if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(name);
  }
  return copied;
}

// Move the preview worktree to the merged commit. `reset --hard` only rewrites
// files whose content differs, and leaves ignored folders (node_modules, build
// caches) alone, so dev servers and incremental builds keep their state.
export async function updatePreview(repo, config, commit) {
  const cwd = config.previewPath;
  const current = await out(['rev-parse', 'HEAD'], { cwd });
  const [currentTree, nextTree] = await Promise.all([
    out(['rev-parse', `${current}^{tree}`], { cwd }),
    out(['rev-parse', `${commit}^{tree}`], { cwd }),
  ]);
  const changed = currentTree === nextTree
    ? []
    : (await out(['diff', '--name-only', '--no-renames', current, commit], { cwd })).split('\n').filter(Boolean);
  await git(['reset', '--hard', '--quiet', commit], { cwd });
  const copied = await copyLocalFiles(repo, config);
  const depsChanged = changed.some((file) => config.installOn.includes(basename(file)));
  return { changed, copied, depsChanged };
}
