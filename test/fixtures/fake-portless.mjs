#!/usr/bin/env node
// Stands in for portless in tests (GITWEAVE_PORTLESS_BIN): `get <name>` prints
// its URL; `<name> <cmd...>` runs the command with a PORT, like the real one.
import { spawn } from 'node:child_process';

const [first, ...rest] = process.argv.slice(2);
if (first === 'get') {
  console.log(`https://${rest[0]}.localhost`);
} else {
  const child = spawn(rest[0], rest.slice(1), { stdio: 'inherit', env: { ...process.env, PORT: '4321', PORTLESS_NAME: first } });
  child.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
