import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git, out } from '../src/git.mjs';
import { Engine } from '../src/engine.mjs';
import { matchesOff, readStatus, setPaused, writeOff } from '../src/status.mjs';
import { addWorktree, fingerprint, read, setup, waitFor, write } from './helpers.mjs';

const quiet = { log: () => {}, appLog: () => {} };

test('preview gets the merge, keeps ignored folders, and only rewrites changed files', async (t) => {
  const { repo, config, main, cleanup } = await setup({ 'app.txt': 'a\n', 'stable.txt': 'same\n', '.gitignore': 'node_modules/\n' });
  t.after(cleanup);
  const engine = new Engine(repo, config, { ...quiet, run: false });
  await engine.cycle({ force: true });
  const preview = config.previewPath;
  write(join(preview, 'node_modules/dep/index.js'), 'kept');
  const stableMtime = statSync(join(preview, 'stable.txt')).mtimeMs;

  const a = await addWorktree(main, 'feature-a');
  write(join(a, 'app.txt'), 'from a\n');
  engine.allDirty = true;
  await engine.cycle();

  assert.equal(read(join(preview, 'app.txt')), 'from a\n');
  assert.equal(read(join(preview, 'node_modules/dep/index.js')), 'kept');
  assert.equal(statSync(join(preview, 'stable.txt')).mtimeMs, stableMtime);
  assert.equal(readStatus(repo).lanes.length, 2);
});

test('nothing changed means no new merge', async (t) => {
  const { repo, config, cleanup } = await setup();
  t.after(cleanup);
  const engine = new Engine(repo, config, { ...quiet, run: false });
  assert.ok(await engine.cycle({ force: true }));
  engine.allDirty = true;
  assert.equal(await engine.cycle(), null);
  assert.equal(engine.cycles, 1);
});

test('watch loop: saves update the preview, bursts coalesce, base moves and new worktrees are picked up', async (t) => {
  const { repo, config, main, cleanup } = await setup();
  const engine = new Engine(repo, config, { ...quiet, run: false });
  t.after(async () => {
    await engine.stop();
    cleanup();
  });
  const a = await addWorktree(main, 'feature-a');
  await engine.start();
  const preview = config.previewPath;
  const startCycles = engine.cycles;

  for (let i = 0; i < 20; i++) {
    write(join(a, 'burst.txt'), `write ${i}\n`);
    await new Promise((r) => setTimeout(r, 5));
  }
  await waitFor(() => existsSync(join(preview, 'burst.txt')) && read(join(preview, 'burst.txt')) === 'write 19\n');
  assert.ok(engine.cycles - startCycles <= 2, `expected at most 2 merges, got ${engine.cycles - startCycles}`);

  write(join(main, 'base.txt'), 'on main\n');
  await git(['add', 'base.txt'], { cwd: main });
  await git(['commit', '-q', '-m', 'base moves'], { cwd: main });
  await waitFor(() => existsSync(join(preview, 'base.txt')));

  const b = await addWorktree(main, 'feature-b');
  write(join(b, 'b.txt'), 'from b\n');
  await waitFor(() => existsSync(join(preview, 'b.txt')));
});

test('pause stops updates and resume catches up', async (t) => {
  const { repo, config, main, cleanup } = await setup();
  const engine = new Engine(repo, config, { ...quiet, run: false });
  t.after(async () => {
    setPaused(repo, false);
    await engine.stop();
    cleanup();
  });
  await engine.start();
  setPaused(repo, true);
  await waitFor(() => readStatus(repo)?.paused === true);
  write(join(main, 'while-paused.txt'), 'x\n');
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!existsSync(join(config.previewPath, 'while-paused.txt')));
  setPaused(repo, false);
  await waitFor(() => existsSync(join(config.previewPath, 'while-paused.txt')));
});

test('turning a lane off removes it from the running preview; on brings it back', async (t) => {
  const { repo, config, main, cleanup } = await setup();
  const engine = new Engine(repo, config, { ...quiet, run: false });
  t.after(async () => {
    await engine.stop();
    cleanup();
  });
  const a = await addWorktree(main, 'feature-a');
  const b = await addWorktree(main, 'claude-x');
  write(join(a, 'a.txt'), 'a\n');
  write(join(b, 'b.txt'), 'b\n');
  await engine.start();
  const preview = config.previewPath;
  assert.ok(existsSync(join(preview, 'a.txt')) && existsSync(join(preview, 'b.txt')));

  writeOff(repo, ['claude-*']);
  await waitFor(() => !existsSync(join(preview, 'b.txt')));
  assert.ok(existsSync(join(preview, 'a.txt')));
  assert.equal(readStatus(repo).lanes.find((l) => l.name === 'claude-x').status, 'off');

  // Edits in an off lane don't trigger anything visible.
  write(join(b, 'b2.txt'), 'b2\n');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!existsSync(join(preview, 'b2.txt')));

  writeOff(repo, []);
  await waitFor(() => existsSync(join(preview, 'b.txt')) && existsSync(join(preview, 'b2.txt')));
});

test('off-list globs match names', () => {
  assert.ok(matchesOff('origin/claude/search', ['origin/claude/*']));
  assert.ok(matchesOff('feature-a', ['feature-a']));
  assert.ok(!matchesOff('feature-ab', ['feature-a']));
  assert.ok(!matchesOff('a.b', ['a*c']));
});

test('remote branches matching a pattern are lanes', async (t) => {
  const { repo, config, main, root, cleanup } = await setup();
  t.after(cleanup);
  const origin = join(root, 'origin.git');
  await git(['init', '-q', '--bare', origin], { cwd: root });
  await git(['remote', 'add', 'origin', origin], { cwd: main });
  await git(['push', '-q', 'origin', 'main'], { cwd: main });
  const clone = join(root, 'cloud');
  await git(['clone', '-q', origin, clone], { cwd: root });
  await git(['checkout', '-q', '-b', 'claude/search'], { cwd: clone });
  write(join(clone, 'search.txt'), 'cloud work\n');
  await git(['add', '-A'], { cwd: clone });
  await git(['-c', 'user.name=c', '-c', 'user.email=c@x', 'commit', '-q', '-m', 'cloud'], { cwd: clone });
  await git(['push', '-q', 'origin', 'claude/search'], { cwd: clone });
  await git(['fetch', '-q', 'origin'], { cwd: main });

  const engine = new Engine(repo, { ...config, remotePatterns: ['origin/claude/*'] }, { ...quiet, run: false });
  const status = await engine.cycle({ force: true });
  assert.ok(status.lanes.some((l) => l.name === 'origin/claude/search' && l.status === 'included'));
  assert.equal(read(join(config.previewPath, 'search.txt')), 'cloud work\n');
});

test('rebuild failure keeps the previous app; success restarts it; dependency changes reinstall', async (t) => {
  const { repo, config, main, root, cleanup } = await setup({ 'app.txt': 'v1\n', 'package.json': '{}\n', '.gitignore': 'node_modules/\nout/\n' });
  const marks = join(root, 'marks');
  const node = JSON.stringify(process.execPath);
  const engine = new Engine(repo, {
    ...config,
    // The "build" copies app.txt to out/, failing if it contains "broken".
    rebuild: `${node} -e "const f=require('fs');const s=f.readFileSync('app.txt','utf8');if(s.includes('broken'))process.exit(3);f.mkdirSync('out',{recursive:true});f.writeFileSync('out/app.txt',s)"`,
    run: `${node} -e "require('fs').appendFileSync(${JSON.stringify(JSON.stringify(marks))},'start '+require('fs').readFileSync('out/app.txt','utf8'));setInterval(()=>{},1000)"`,
    install: `${node} -e "require('fs').appendFileSync(${JSON.stringify(JSON.stringify(marks))},'install\\n')"`,
  }, quiet);
  t.after(async () => {
    await engine.stop();
    cleanup();
  });

  await engine.start();
  await waitFor(() => existsSync(marks) && read(marks).includes('start v1'));
  assert.ok(read(marks).startsWith('install\n'), 'first preview installs dependencies');

  write(join(main, 'app.txt'), 'broken\n');
  await waitFor(() => readStatus(repo)?.build?.state === 'failed');
  assert.ok(!read(marks).includes('broken'));
  assert.ok(engine.runner.child, 'previous app still running');

  write(join(main, 'app.txt'), 'v2\n');
  await waitFor(() => read(marks).includes('start v2'));

  write(join(main, 'package.json'), '{"dependencies":{}}\n');
  await waitFor(() => read(marks).split('install').length === 3);
});

test('engine never modifies source worktrees', async (t) => {
  const { repo, config, main, cleanup } = await setup();
  t.after(cleanup);
  const a = await addWorktree(main, 'feature-a');
  write(join(a, 'app.txt'), 'edited\n');
  write(join(a, 'untracked.txt'), 'new\n');
  await git(['add', 'untracked.txt'], { cwd: a });
  const before = await Promise.all([main, a].map(fingerprint));
  await new Engine(repo, config, { ...quiet, run: false }).cycle({ force: true });
  assert.deepEqual(await Promise.all([main, a].map(fingerprint)), before);
  assert.equal(config.previewPath, join(repo.stateDir, 'preview'));
  assert.equal(await out(['rev-parse', 'HEAD'], { cwd: config.previewPath }), readStatus(repo).merged);
});
