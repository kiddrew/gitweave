import { IDENTITY, git, out } from './git.mjs';
import { applyResolution, conflictKey, loadResolution, parseStages } from './resolve.mjs';

// Merge each lane onto the base in order, entirely in memory. A lane that
// conflicts uses a cached resolution when one exists for exactly that
// collision; otherwise it is left out (with what's needed to resolve it) and
// the rest still integrate.
export async function integrate(cwd, baseCommit, lanes, { repo } = {}) {
  let commit = baseCommit;
  let tree = await out(['rev-parse', `${baseCommit}^{tree}`], { cwd });
  const results = [];

  for (const lane of lanes) {
    const entry = { name: lane.name, kind: lane.kind, commit: lane.commit || null };
    if (lane.off) {
      results.push({ ...entry, status: 'off', reason: 'turned off' });
      continue;
    }
    if (lane.stale) {
      results.push({ ...entry, status: 'stale', reason: `no commits in ${lane.ageDays} days`, ageDays: lane.ageDays });
      continue;
    }
    if (!lane.commit) {
      results.push({ ...entry, status: 'error', reason: lane.error || 'No snapshot.' });
      continue;
    }
    let merged;
    try {
      merged = await git(['merge-tree', '--write-tree', '--no-messages', commit, lane.commit], { cwd, ok: [0, 1] });
    } catch (error) {
      results.push({ ...entry, status: 'error', reason: (error.stderr || error.message).trim().split('\n')[0] });
      continue;
    }
    let [mergedTree, ...rest] = merged.stdout.split('\n');
    if (merged.code === 1) {
      const stages = parseStages(rest);
      const conflicts = [...new Set(stages.map((s) => s.path))];
      const key = conflictKey(stages);
      const resolution = repo && loadResolution(repo, key);
      if (!resolution) {
        results.push({ ...entry, status: 'excluded', reason: 'conflict', conflicts, resolve: { key, ours: commit, theirs: lane.commit } });
        continue;
      }
      mergedTree = await applyResolution(repo, mergedTree.trim(), resolution);
      entry.resolved = conflicts;
    }
    if (mergedTree.trim() !== tree) {
      tree = mergedTree.trim();
      commit = await out(['commit-tree', tree, '-p', commit, '-p', lane.commit, '-m', `gitweave: merge ${lane.name}`], { cwd, env: IDENTITY });
    }
    results.push({ ...entry, status: 'included' });
  }
  return { commit, tree, lanes: results };
}
