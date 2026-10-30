import { basename } from 'node:path';
import { git, out } from './git.mjs';
import { listWorktrees, realpathMaybe } from './repo.mjs';
import { remotePatterns } from './status.mjs';
import { prRef, readPullRequests } from './prs.mjs';

const ZERO = /^0+$/;

// Every worktree (except the preview) is a lane, plus remote branches matching
// the configured patterns. Order is fixed so merges are reproducible.
export async function discoverLanes(repo, config) {
  const preview = realpathMaybe(config.previewPath);
  const local = [];
  for (const wt of await listWorktrees(repo.main)) {
    if (wt.bare || wt.prunable || !wt.head || ZERO.test(wt.head)) continue;
    if (realpathMaybe(wt.path) === preview) continue;
    const name = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : `@${basename(wt.path)}`;
    local.push({ kind: 'worktree', name, path: wt.path, main: wt.path === repo.main });
  }

  const remote = [];
  for (const pattern of remotePatterns(repo, config)) {
    const refs = await out(['for-each-ref', '--format=%(refname) %(committerdate:unix)', `refs/remotes/${pattern}`], { cwd: repo.main });
    for (const line of refs.split('\n').filter(Boolean)) {
      const [ref, date] = line.split(' ');
      if (ref.endsWith('/HEAD')) continue;
      // Already merged into the base (or the base itself): nothing to preview.
      if (config.base && ref === `refs/remotes/${config.base}`) continue;
      const merged = await git(['merge-base', '--is-ancestor', ref, config.base], { cwd: repo.main, ok: [0, 1] });
      if (merged.code === 0) continue;
      const lane = { kind: 'remote', name: ref.slice('refs/remotes/'.length), ref };
      // Abandoned branches stay listed but out of the merge.
      const ageDays = Math.floor((Date.now() / 1000 - Number(date)) / 86400);
      if (config.staleDays > 0 && ageDays > config.staleDays) Object.assign(lane, { stale: true, ageDays });
      remote.push(lane);
    }
  }

  // Open, non-draft PRs (on by default). A PR whose branch is checked out here
  // is already a worktree lane (with uncommitted edits), and its branch on the
  // remote is the same work, so neither is listed twice.
  const prs = [];
  if (config.prs) {
    const checkedOut = new Set(local.map((l) => l.name));
    for (const pr of readPullRequests(repo)) {
      if (!pr.fork && checkedOut.has(pr.branch)) continue;
      prs.push({ kind: 'pr', name: `pr/${pr.number}`, ref: prRef(pr.number), number: pr.number, title: pr.title, branch: pr.branch });
      if (!pr.fork) {
        const dup = remote.findIndex((l) => l.name.endsWith(`/${pr.branch}`) && l.name.split('/').length === pr.branch.split('/').length + 1);
        if (dup !== -1) remote.splice(dup, 1);
      }
    }
  }

  const seen = new Map();
  const lanes = [...local, ...prs, ...remote].map((lane) => {
    const count = (seen.get(lane.name) || 0) + 1;
    seen.set(lane.name, count);
    return count === 1 ? lane : { ...lane, name: `${lane.name}#${count}` };
  });

  const rank = (lane) => {
    const pinned = config.order.indexOf(lane.name);
    if (pinned !== -1) return [0, pinned];
    if (lane.main) return [1, 0];
    return [lane.kind === 'worktree' ? 2 : lane.kind === 'pr' ? 3 : 4, lane.number || 0];
  };
  return lanes.sort((a, b) => {
    const [ra, ia] = rank(a);
    const [rb, ib] = rank(b);
    return ra - rb || ia - ib || a.name.localeCompare(b.name);
  });
}
