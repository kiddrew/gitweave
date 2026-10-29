import { IDENTITY, git, out } from './git.mjs';

// Merge each lane onto the base in order, entirely in memory. A lane that
// conflicts (or fails to merge) is left out and the rest still integrate.
export async function integrate(cwd, baseCommit, lanes) {
  let commit = baseCommit;
  let tree = await out(['rev-parse', `${baseCommit}^{tree}`], { cwd });
  const results = [];

  for (const lane of lanes) {
    const entry = { name: lane.name, kind: lane.kind, commit: lane.commit || null };
    if (lane.off) {
      results.push({ ...entry, status: 'off', reason: 'turned off' });
      continue;
    }
    if (!lane.commit) {
      results.push({ ...entry, status: 'error', reason: lane.error || 'No snapshot.' });
      continue;
    }
    let merged;
    try {
      merged = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', commit, lane.commit], { cwd, ok: [0, 1] });
    } catch (error) {
      results.push({ ...entry, status: 'error', reason: (error.stderr || error.message).trim().split('\n')[0] });
      continue;
    }
    const [mergedTree, ...rest] = merged.stdout.split('\n');
    if (merged.code === 1) {
      const conflicts = [...new Set(rest.map((line) => line.trim()).filter(Boolean))];
      results.push({ ...entry, status: 'excluded', reason: 'conflict', conflicts });
      continue;
    }
    if (mergedTree.trim() !== tree) {
      tree = mergedTree.trim();
      commit = await out(['commit-tree', tree, '-p', commit, '-p', lane.commit, '-m', `lanes: merge ${lane.name}`], { cwd, env: IDENTITY });
    }
    results.push({ ...entry, status: 'included' });
  }
  return { commit, tree, lanes: results };
}
