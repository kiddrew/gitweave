#!/usr/bin/env node
// Stands in for the AI resolver: keeps both sides of every conflict in the
// files gitweave lists, and counts runs in $FAKE_RESOLVER_LOG.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

if (process.env.FAKE_RESOLVER_LOG) appendFileSync(process.env.FAKE_RESOLVER_LOG, `${process.env.GITWEAVE_LANE}\n`);
if (process.env.FAKE_RESOLVER_FAIL) process.exit(3);
if (process.env.FAKE_RESOLVER_SIGNED_OUT && !existsSync(process.env.FAKE_RESOLVER_SIGNED_OUT)) {
  console.error('Failed to authenticate. API Error: 401 OAuth access token has expired.');
  process.exit(1);
}
for (const file of process.env.GITWEAVE_FILES.split('\n')) {
  const text = readFileSync(file, 'utf8').split('\n').filter((line) => !/^(<{7}|={7}|>{7})( |$)/.test(line)).join('\n');
  writeFileSync(file, text);
}
