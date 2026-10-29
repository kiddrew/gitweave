import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const statusFile = (repo) => join(repo.stateDir, 'status.json');
export const pauseFile = (repo) => join(repo.stateDir, 'paused');

export function writeStatus(repo, status) {
  const file = statusFile(repo);
  writeFileSync(`${file}.tmp`, JSON.stringify(status, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function readStatus(repo) {
  const file = statusFile(repo);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export const offFile = (repo) => join(repo.stateDir, 'off.json');

// Lanes the user switched off. Entries are names or simple `*` globs, so
// `lanes off 'origin/claude/*'` also covers branches that appear later.
export function readOff(repo) {
  const file = offFile(repo);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function writeOff(repo, entries) {
  const unique = [...new Set(entries)].sort();
  if (unique.length) writeFileSync(offFile(repo), JSON.stringify(unique, null, 2));
  else rmSync(offFile(repo), { force: true });
  return unique;
}

export function matchesOff(name, entries) {
  return entries.some((entry) => entry === name
    || (entry.includes('*') && new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name)));
}

export const isPaused = (repo) => existsSync(pauseFile(repo));
export const setPaused = (repo, paused) => (paused ? writeFileSync(pauseFile(repo), new Date().toISOString()) : rmSync(pauseFile(repo), { force: true }));

const short = (sha) => (sha ? sha.slice(0, 7) : '-------');

export function summarize(status, { time: withTime = true } = {}) {
  if (!status) return 'No status yet. Run `lanes up` or `lanes merge`.';
  const time = withTime ? `${new Date(status.updatedAt).toLocaleTimeString()} ` : '';
  const included = status.lanes.filter((l) => l.status === 'included').map((l) => l.name);
  const off = status.lanes.filter((l) => l.status === 'off').map((l) => l.name);
  const problems = status.lanes.filter((l) => l.status !== 'included' && l.status !== 'off')
    .map((l) => `${l.name} (${l.conflicts?.length ? `conflict: ${l.conflicts.join(', ')}` : l.reason})`);
  const mark = status.paused ? '⏸' : status.build?.state === 'failed' ? '✗' : '✓';
  let line = `${mark} ${time}preview @ ${short(status.merged)} on ${status.base.name} · lanes: ${included.length ? included.join(', ') : 'none'}`;
  if (off.length) line += ` · off: ${off.join(', ')}`;
  if (problems.length) line += ` · excluded: ${problems.join('; ')}`;
  if (status.build?.state === 'failed') line += ` · ${status.build.step} failed, previous app still running`;
  if (status.paused) line += ' · paused';
  return line;
}
