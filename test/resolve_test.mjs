import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/git.mjs';
import { Engine } from '../src/engine.mjs';
import { readStatus } from '../src/status.mjs';
import { addWorktree, read, setup, waitFor, write } from './helpers.mjs';

const quiet = { log: process.env.DEBUG_TEST ? console.log : () => {}, appLog: () => {} };
const FAKE = fileURLToPath(new URL('./fixtures/fake-resolver.mjs', import.meta.url));

async function conflicting(t, env = {}) {
  const fixture = await setup({ 'app.txt': 'one\n', '.gitignore': 'node_modules/\n' }, { resolveCommand: FAKE });
  const log = join(fixture.root, 'resolver.log');
  Object.assign(process.env, { FAKE_RESOLVER_LOG: log, ...env });
  // main and the lane both change the same line.
  write(join(fixture.main, 'app.txt'), 'from main\n');
  const a = await addWorktree(fixture.main, 'feature-a');
  write(join(a, 'app.txt'), 'from a\n');
  const engine = new Engine(fixture.repo, fixture.config, { ...quiet, run: false, resolveConflicts: true });
  t.after(async () => {
    await engine.stop();
    delete process.env.FAKE_RESOLVER_LOG;
    delete process.env.FAKE_RESOLVER_FAIL;
    delete process.env.FAKE_RESOLVER_SIGNED_OUT;
    fixture.cleanup();
  });
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  return { ...fixture, a, engine, runs };
}

const lane = (repo, name) => readStatus(repo)?.lanes.find((l) => l.name === name);

test('resolve: a conflicting lane is resolved in the background and then included', async (t) => {
  const { repo, config, main, a, engine, runs } = await conflicting(t);
  const before = await git(['status', '--porcelain'], { cwd: a });
  await engine.start();
  await waitFor(() => lane(repo, 'feature-a')?.status === 'included');
  assert.deepEqual(lane(repo, 'feature-a').resolved, ['app.txt']);
  assert.equal(read(join(config.previewPath, 'app.txt')), 'from main\nfrom a\n');
  assert.equal(runs(), 1);
  // The lane's own worktree is untouched.
  assert.equal((await git(['status', '--porcelain'], { cwd: a })).stdout, before.stdout);

  // An unrelated change elsewhere reuses the cached resolution.
  write(join(main, 'other.txt'), 'x\n');
  await waitFor(() => existsSync(join(config.previewPath, 'other.txt')));
  assert.equal(lane(repo, 'feature-a').status, 'included');
  assert.equal(runs(), 1);

  // A new collision in the same file is resolved again.
  write(join(a, 'app.txt'), 'from a, edited\n');
  await waitFor(() => read(join(config.previewPath, 'app.txt')) === 'from main\nfrom a, edited\n');
  assert.equal(runs(), 2);
});

test('resolve: a failed resolution leaves the lane out and says why', async (t) => {
  const { repo, engine, runs } = await conflicting(t, { FAKE_RESOLVER_FAIL: '1' });
  await engine.start();
  await waitFor(() => lane(repo, 'feature-a')?.resolving?.state === 'failed');
  assert.equal(lane(repo, 'feature-a').status, 'excluded');
  assert.match(lane(repo, 'feature-a').resolving.reason, /resolver exited 3/);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(runs(), 1, 'no retry until the conflict changes');
});

test('resolve: when the resolver needs a sign-in, it says so and retries until it works', async (t) => {
  const token = join(tmpdir(), `gitweave-signed-in-${process.pid}`);
  rmSync(token, { force: true });
  process.env.GITWEAVE_LOGIN_RETRY_MS = '200';
  t.after(() => {
    delete process.env.GITWEAVE_LOGIN_RETRY_MS;
    rmSync(token, { force: true });
  });
  const { repo, engine } = await conflicting(t, { FAKE_RESOLVER_SIGNED_OUT: token });
  await engine.start();
  await waitFor(() => lane(repo, 'feature-a')?.resolving?.state === 'login');
  assert.equal(lane(repo, 'feature-a').status, 'excluded');
  writeFileSync(token, '');
  await waitFor(() => lane(repo, 'feature-a')?.status === 'included');
});
