import { execFile } from 'node:child_process';
import { basename } from 'node:path';

const bin = () => process.env.GITWEAVE_PORTLESS_BIN || 'portless';

// `true` names the preview gitweave.<repo>, beside portless's own <repo> and
// <worktree>.<repo> names for the checkouts; a string picks the name.
export function portlessName(repo, config) {
  const raw = typeof config.portless === 'string' ? config.portless : `gitweave.${basename(repo.main)}`;
  return raw.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

const quote = (arg) => (/^[\w./@:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

// The app command wrapped so portless gives it a port and routes the name to it.
// A plain command (`npm run dev`) is passed as is, so portless can recognize the
// framework and inject --port; one using shell syntax runs under `sh -c` so its
// pipes, redirects and variables stay inside portless.
export function portlessCommand(name, run) {
  const plain = /^[\w./@:=+, -]+$/.test(run.trim());
  return `${quote(bin())} ${quote(name)} ${plain ? run.trim() : `sh -c ${quote(run)}`}`;
}

// The URL portless serves the name at, or null when portless isn't installed.
export function portlessUrl(name) {
  return new Promise((resolve) => {
    execFile(bin(), ['get', name], { timeout: 15000 }, (error, stdout) => resolve(error ? null : stdout.trim().split('\n').pop() || null));
  });
}
