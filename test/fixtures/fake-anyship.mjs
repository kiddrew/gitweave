#!/usr/bin/env node
// Stands in for the anyship CLI in tests (GITWEAVE_ANYSHIP_BIN). Each call is
// appended to $FAKE_ANYSHIP_LOG; FAKE_ANYSHIP_FAIL=1 makes deploys fail.
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const list = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(dir, e.name)) : [join(dir, e.name)]));
const files = list(process.cwd()).map((f) => relative(process.cwd(), f)).sort();
appendFileSync(process.env.FAKE_ANYSHIP_LOG, JSON.stringify({ args, files }) + '\n');

if (args[0] === 'deploy') {
  if (process.env.FAKE_ANYSHIP_FAIL) {
    console.error('upload failed (500)');
    process.exit(1);
  }
  const at = args.indexOf('--project');
  if (at >= 0) {
    mkdirSync('.anyship', { recursive: true });
    writeFileSync('.anyship/project.json', JSON.stringify({ app: args[at + 1], slug: 'fake-123' }));
  }
  console.log('{"ok":true}');
} else if (args[0] === 'status') {
  if (!existsSync('.anyship/project.json')) process.exit(1);
  console.log(JSON.stringify({ latest: { status: 'deployed', url: 'https://fake-123.anyshipapp.dev' } }));
}
