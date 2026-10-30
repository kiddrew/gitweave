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
// `gitweave off 'origin/claude/*'` also covers branches that appear later.
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

export const remotesFile = (repo) => join(repo.stateDir, 'remotes.json');

// Remote branches added with `gitweave add` (names or `*` globs), on top of
// "remotePatterns" in gitweave.json.
export function readRemotes(repo) {
  const file = remotesFile(repo);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function writeRemotes(repo, entries) {
  const unique = [...new Set(entries)].sort();
  if (unique.length) writeFileSync(remotesFile(repo), JSON.stringify(unique, null, 2));
  else rmSync(remotesFile(repo), { force: true });
  return unique;
}

export const remotePatterns = (repo, config) => [...new Set([...config.remotePatterns, ...readRemotes(repo)])];

export const isPaused = (repo) => existsSync(pauseFile(repo));
export const setPaused = (repo, paused) => (paused ? writeFileSync(pauseFile(repo), new Date().toISOString()) : rmSync(pauseFile(repo), { force: true }));

const short = (sha) => (sha ? sha.slice(0, 7) : '-------');

export function anyshipLine(anyship) {
  if (!anyship || anyship.state === 'idle') return 'anyship: waiting for the first deploy';
  const outcome = anyship.state === 'failed' ? `failed: ${anyship.reason}` : anyship.state;
  return `anyship: ${anyship.url || '(no url yet)'} @ ${short(anyship.commit)} (${outcome})`;
}

export function summarize(status, { time: withTime = true } = {}) {
  if (!status) return 'No status yet. Run `gitweave up` or `gitweave merge`.';
  const time = withTime ? `${new Date(status.updatedAt).toLocaleTimeString()} ` : '';
  const included = status.lanes.filter((l) => l.status === 'included').map((l) => l.name);
  const off = status.lanes.filter((l) => l.status === 'off').map((l) => l.name);
  const stale = status.lanes.filter((l) => l.status === 'stale').length;
  const problems = status.lanes.filter((l) => !['included', 'off', 'stale'].includes(l.status))
    .map((l) => `${l.name} (${l.resolving?.state === 'resolving' ? 'resolving' : l.conflicts?.length ? `conflict: ${l.conflicts.join(', ')}` : l.reason})`);
  const mark = status.paused ? '⏸' : status.build?.state === 'failed' ? '✗' : '✓';
  let line = `${mark} ${time}preview @ ${short(status.merged)} on ${status.base.name} · lanes: ${included.length ? included.join(', ') : 'none'}`;
  if (off.length) line += ` · off: ${off.join(', ')}`;
  if (stale) line += ` · ${stale} stale skipped`;
  if (problems.length) line += ` · excluded: ${problems.join('; ')}`;
  if (status.build?.state === 'failed') line += ` · ${status.build.step} failed, previous app still running`;
  if (status.local) line += ` · ${status.local}`;
  if (status.paused) line += ' · paused';
  return line;
}

const paint = (code) => (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1), dim = paint(2), green = paint(32), yellow = paint(33), red = paint(31), cyan = paint(36);

// The multi-line report `gitweave up` prints once it is running in the background.
export function startupReport(status, pid) {
  const rows = [];
  const row = (label, values, color = (v) => v) => [].concat(values).forEach((v, i) => rows.push(`  ${dim((i ? '' : label).padEnd(10))}${color(v)}`));
  if (status) {
    if (status.local) row('URL', status.local, (v) => bold(cyan(v)));
    row('Preview', `${short(status.merged)} on ${status.base.name}  ${dim(new Date(status.updatedAt).toLocaleTimeString())}`);
    const included = status.lanes.filter((l) => l.status === 'included');
    row('Lanes', included.length ? included.map((l) => `${green('●')} ${l.name}${l.resolved?.length ? dim('  (conflicts resolved)') : ''}`) : dim('none'));
    const waiting = status.lanes.filter((l) => !['included', 'off', 'stale'].includes(l.status));
    if (waiting.length) row('Excluded', waiting.map((l) => {
      const why = l.resolving?.state === 'resolving' ? 'resolving conflicts…' : l.resolving?.state === 'failed' ? `could not resolve: ${l.resolving.reason}` : l.conflicts?.length ? `conflict: ${l.conflicts.join(', ')}` : l.reason;
      return `${l.resolving?.state === 'resolving' ? yellow('◐') : red('●')} ${l.name}  ${dim(why)}`;
    }));
    const off = status.lanes.filter((l) => l.status === 'off').map((l) => l.name);
    if (off.length) row('Off', off.join(', '), dim);
    const stale = status.lanes.filter((l) => l.status === 'stale').length;
    if (stale) row('Stale', `${stale} skipped`, dim);
    if (status.build?.state === 'failed') row('Build', `${status.build.step} failed, previous app still running`, red);
    if (status.anyship && status.anyship.state !== 'idle') row('Anyship', anyshipLine(status.anyship).replace(/^anyship: /, ''));
    if (status.paused) row('Paused', 'merges and deploys are paused', yellow);
  }
  return [
    `${green('✓')} ${bold('gitweave is running')} ${dim(`(pid ${pid})`)}`,
    '',
    ...rows,
    ...(rows.length ? [''] : []),
    dim('  gitweave ls · gitweave logs -f · gitweave down'),
  ].join('\n');
}
