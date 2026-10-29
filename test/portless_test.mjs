import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { portlessCommand, portlessName } from '../src/portless.mjs';
import { readStatus } from '../src/status.mjs';
import { read, setup, waitFor } from './helpers.mjs';

const quiet = { log: () => {}, appLog: () => {} };
const FAKE = fileURLToPath(new URL('./fixtures/fake-portless.mjs', import.meta.url));

test('portless: the app runs under a stable .localhost name shown in status', async (t) => {
  const { repo, config, cleanup } = await setup(undefined, { portless: true, run: 'echo "$PORTLESS_NAME $PORT" > ran.txt; sleep 30' });
  process.env.GITWEAVE_PORTLESS_BIN = FAKE;
  const engine = new Engine(repo, config, quiet);
  t.after(async () => {
    delete process.env.GITWEAVE_PORTLESS_BIN;
    await engine.stop();
    cleanup();
  });
  await engine.start();
  const name = `gitweave.${basename(repo.main)}`;
  await waitFor(() => read(join(config.previewPath, 'ran.txt')).endsWith('\n'));
  assert.equal(read(join(config.previewPath, 'ran.txt')), `${name} 4321\n`);
  assert.equal(readStatus(repo).local, `https://${name}.localhost`);
});

test('portless: a configured name is used and sanitized; a missing binary falls back to the plain app', async (t) => {
  assert.equal(portlessName({ main: '/x/My Repo' }, { portless: true }), 'gitweave.my-repo');
  assert.equal(portlessName({ main: '/x/r' }, { portless: 'Team.App' }), 'team.app');

  const { repo, config, cleanup } = await setup(undefined, { portless: true, run: 'echo "${PORT:-none}" > ran.txt; sleep 30' });
  process.env.GITWEAVE_PORTLESS_BIN = '/nonexistent/portless';
  const engine = new Engine(repo, config, quiet);
  t.after(async () => {
    delete process.env.GITWEAVE_PORTLESS_BIN;
    await engine.stop();
    cleanup();
  });
  await engine.start();
  await waitFor(() => read(join(config.previewPath, 'ran.txt')).endsWith('\n'));
  assert.equal(read(join(config.previewPath, 'ran.txt')), 'none\n');
  assert.equal(readStatus(repo).local, undefined);
});

test('portless: plain commands pass through so framework detection works; shell syntax is wrapped', () => {
  process.env.GITWEAVE_PORTLESS_BIN = 'portless';
  assert.equal(portlessCommand('n', 'npm run dev'), 'portless n npm run dev');
  assert.equal(portlessCommand('n', 'PORT=1 vite | tee log'), `portless n sh -c 'PORT=1 vite | tee log'`);
  delete process.env.GITWEAVE_PORTLESS_BIN;
});
