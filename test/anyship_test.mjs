import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { anyshipLine, readStatus, setPaused } from '../src/status.mjs';
import { addWorktree, setup, waitFor, write } from './helpers.mjs';

const quiet = { log: () => {}, appLog: () => {} };
const FAKE = fileURLToPath(new URL('./fixtures/fake-anyship.mjs', import.meta.url));

// A repo whose main checkout has been deployed to Anyship once, with the fake CLI on.
async function anyshipSetup(t, { manifest = true, files } = {}) {
  const fixture = await setup(files || { 'app.txt': 'one\n', '.env.production': 'SECRET=1\n', 'certs/server.key': 'k\n', '.gitignore': '.anyship/\n' }, { anyship: true, anyshipDebounceSec: 0.3 });
  if (manifest) write(join(fixture.main, '.anyship/project.json'), JSON.stringify({ app: 'Demo', slug: 'demo-1' }));
  const log = join(fixture.root, 'anyship.log');
  process.env.GITWEAVE_ANYSHIP_BIN = FAKE;
  process.env.FAKE_ANYSHIP_LOG = log;
  process.env.GITWEAVE_ANYSHIP_POLL_MS = '50';
  delete process.env.FAKE_ANYSHIP_FAIL;
  const engine = new Engine(fixture.repo, fixture.config, { ...quiet, run: false, deploy: true });
  t.after(async () => {
    setPaused(fixture.repo, false);
    await engine.stop();
    delete process.env.FAKE_ANYSHIP_FAIL;
    fixture.cleanup();
  });
  const calls = (cmd = 'deploy') => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []).filter((c) => c.args[0] === cmd);
  return { ...fixture, engine, calls };
}

const anyship = (repo) => readStatus(repo)?.anyship;

test('anyship: deploys the merge to a separate project, without secrets, and redeploys on change', async (t) => {
  const { repo, main, engine, calls } = await anyshipSetup(t);
  await engine.start();
  await waitFor(() => anyship(repo)?.state === 'ok');
  const first = calls()[0];
  assert.deepEqual(first.args, ['deploy', '--project', 'Demo-integration', '.']);
  assert.ok(first.files.includes('app.txt'));
  assert.ok(!first.files.some((f) => f.includes('.env') || f.endsWith('.key')), first.files.join(','));
  assert.equal(anyship(repo).url, 'https://fake-123.anyshipapp.dev');
  assert.equal(anyship(repo).commit, readStatus(repo).merged);
  assert.match(anyshipLine(anyship(repo)), /^anyship: https:\/\/fake-123\.anyshipapp\.dev @ [0-9a-f]{7} \(ok\)$/);

  const a = await addWorktree(main, 'feature-a');
  write(join(a, 'a.txt'), 'from a\n');
  await waitFor(() => calls().length === 2 && anyship(repo)?.state === 'ok' && anyship(repo).commit === readStatus(repo).merged);
  // Later deploys use the integration project's own recorded identity.
  assert.deepEqual(calls()[1].args, ['deploy', '.']);
  assert.ok(calls()[1].files.includes('a.txt'));
});

test('anyship: changes inside the quiet period coalesce into one deploy', async (t) => {
  const { repo, main, engine, calls, config } = await anyshipSetup(t);
  config.anyshipDebounceSec = 1;
  await engine.start();
  for (let i = 0; i < 4; i++) {
    write(join(main, 'burst.txt'), `write ${i}\n`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await waitFor(() => anyship(repo)?.state === 'ok');
  assert.ok(engine.cycles >= 2, `expected several merges, got ${engine.cycles}`);
  assert.equal(calls().length, 1);
  assert.equal(anyship(repo).commit, readStatus(repo).merged);
});

test('anyship: an unchanged merge is not redeployed', async (t) => {
  const { repo, engine, calls } = await anyshipSetup(t);
  await engine.start();
  await waitFor(() => anyship(repo)?.state === 'ok');
  engine.deployer.schedule(readStatus(repo).merged, readStatus(repo).base.commit);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(calls().length, 1);
});

test('anyship: without .anyship/project.json, deploys turn off with a warning', async (t) => {
  const { repo, engine, calls } = await anyshipSetup(t, { manifest: false });
  const lines = [];
  engine.deployer.log = (line) => lines.push(line);
  await engine.start();
  await waitFor(() => anyship(repo)?.state === 'failed');
  assert.match(anyship(repo).reason, /deploy this project to Anyship once first/);
  assert.equal(lines.filter((l) => l.includes('once first')).length, 1);
  assert.equal(engine.deployer.disabled, true);
  assert.equal(calls().length, 0);
});

test('anyship: a failed deploy is recorded and retried on the next change', async (t) => {
  const { repo, main, engine, calls } = await anyshipSetup(t);
  process.env.FAKE_ANYSHIP_FAIL = '1';
  await engine.start();
  await waitFor(() => anyship(repo)?.state === 'failed');
  assert.match(anyship(repo).reason, /upload failed \(500\)/);
  assert.match(anyshipLine(anyship(repo)), /\(failed: upload failed \(500\)\)$/);

  delete process.env.FAKE_ANYSHIP_FAIL;
  write(join(main, 'next.txt'), 'x\n');
  await waitFor(() => anyship(repo)?.state === 'ok');
  assert.equal(calls().length, 2);
});

test('anyship: no deploys while paused; resume deploys', async (t) => {
  const { repo, engine, calls } = await anyshipSetup(t);
  await engine.start();
  // Pause inside the quiet period: the merge happened, its deploy must wait.
  setPaused(repo, true);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(calls().length, 0);
  setPaused(repo, false);
  await waitFor(() => anyship(repo)?.state === 'ok');
  assert.equal(calls().length, 1);
});
