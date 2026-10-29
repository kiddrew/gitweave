import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';
import { out } from '../src/git.mjs';
import { discoverLanes } from '../src/lanes.mjs';
import { snapshotWorktree } from '../src/snapshot.mjs';
import { integrate } from '../src/merge.mjs';
import { addWorktree, fingerprint, setup, write } from './helpers.mjs';

async function snapshotAll(repo, config) {
  const lanes = await discoverLanes(repo, config);
  for (const lane of lanes) Object.assign(lane, await snapshotWorktree(repo, lane));
  return lanes;
}

const show = (repo, commit, path) => out(['show', `${commit}:${path}`], { cwd: repo.main });

test('merges uncommitted work from several worktrees and excludes the conflicting one', async (t) => {
  const { repo, config, main, cleanup } = await setup();
  t.after(cleanup);
  const a = await addWorktree(main, 'feature-a');
  const b = await addWorktree(main, 'feature-b');
  const c = await addWorktree(main, 'feature-c');
  write(join(a, 'app.txt'), 'ONE\ntwo\nthree\n');
  write(join(b, 'new.txt'), 'brand new\n');
  write(join(c, 'app.txt'), 'uno\ntwo\nthree\n');

  const before = await Promise.all([main, a, b, c].map(fingerprint));
  const lanes = await snapshotAll(repo, config);
  const base = await out(['rev-parse', 'main'], { cwd: main });
  const result = await integrate(main, base, lanes);
  const after = await Promise.all([main, a, b, c].map(fingerprint));

  assert.deepEqual(after, before, 'source worktrees must be untouched');
  const status = Object.fromEntries(result.lanes.map((l) => [l.name, l.status]));
  assert.deepEqual(status, { main: 'included', 'feature-a': 'included', 'feature-b': 'included', 'feature-c': 'excluded' });
  assert.deepEqual(result.lanes.find((l) => l.name === 'feature-c').conflicts, ['app.txt']);
  assert.equal(await show(repo, result.commit, 'app.txt'), 'ONE\ntwo\nthree');
  assert.equal(await show(repo, result.commit, 'new.txt'), 'brand new');
});

test('carries deletions and binary files, skips ignored files', async (t) => {
  const { repo, config, main, cleanup } = await setup({ 'app.txt': 'x\n', 'old.txt': 'gone soon\n', '.gitignore': 'node_modules/\n' });
  t.after(cleanup);
  const a = await addWorktree(main, 'feature-a');
  unlinkSync(join(a, 'old.txt'));
  writeFileSync(join(a, 'image.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
  write(join(a, 'node_modules/pkg/index.js'), 'ignored');

  const lanes = await snapshotAll(repo, config);
  const result = await integrate(main, await out(['rev-parse', 'main'], { cwd: main }), lanes);
  const files = (await out(['ls-tree', '-r', '--name-only', result.commit], { cwd: main })).split('\n');
  assert.ok(!files.includes('old.txt'));
  assert.ok(files.includes('image.bin'));
  assert.ok(!files.some((f) => f.startsWith('node_modules')));
});

test('a clean worktree snapshots to its own HEAD and repeat snapshots are stable', async (t) => {
  const { repo, config, main, cleanup } = await setup();
  t.after(cleanup);
  const [lane] = await discoverLanes(repo, config);
  const first = await snapshotWorktree(repo, lane);
  assert.equal(first.commit, await out(['rev-parse', 'HEAD'], { cwd: main }));
  write(join(main, 'app.txt'), 'changed\n');
  const second = await snapshotWorktree(repo, lane, first);
  assert.notEqual(second.commit, first.commit);
  assert.equal(await snapshotWorktree(repo, lane, second), second);
});

test('lane order is fixed: pinned, main worktree, worktrees, remotes', async (t) => {
  const { repo, main, cleanup, config } = await setup();
  t.after(cleanup);
  await addWorktree(main, 'zeta');
  await addWorktree(main, 'alpha');
  await addWorktree(main, 'pinned');
  const names = (await discoverLanes(repo, { ...config, order: ['pinned'] })).map((l) => l.name);
  assert.deepEqual(names, ['pinned', 'main', 'alpha', 'zeta']);
});
