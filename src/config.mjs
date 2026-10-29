import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { git, out } from './git.mjs';

export const CONFIG_FILE = 'braid.json';

export const DEFAULTS = {
  base: null,
  previewPath: null,
  run: null,
  rebuild: null,
  install: null,
  installOn: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'],
  remotePatterns: [],
  order: [],
  ignore: ['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.turbo', '.cache', '.svelte-kit', 'coverage'],
  copy: ['.env', '.env.local', '.dev.vars'],
  settleMs: 1500,
  pollMs: 2000,
  fetchIntervalSec: 60,
};

export async function detectBase(cwd) {
  for (const name of ['main', 'master']) {
    const { code } = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd, ok: [0, 1] });
    if (code === 0) return name;
  }
  const remoteHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, ok: [0, 1] });
  if (remoteHead.code === 0) return remoteHead.stdout.trim();
  throw new Error('Could not detect a base branch. Set "base" in braid.json.');
}

export function defaultPreviewPath(main) {
  return `${main}-braid-preview`;
}

export async function loadConfig(repo, overrides = {}) {
  const file = join(repo.main, CONFIG_FILE);
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const config = { ...DEFAULTS, ...fromFile, ...overrides };
  config.base ||= await detectBase(repo.main);
  config.previewPath = resolve(repo.main, config.previewPath || defaultPreviewPath(repo.main));
  await out(['rev-parse', '--verify', `${config.base}^{commit}`], { cwd: repo.main }).catch(() => {
    throw new Error(`Base "${config.base}" does not resolve to a commit.`);
  });
  return config;
}

// A starting config guessed from the project, written by `braid init`.
export async function suggestConfig(repo) {
  const suggestion = { base: await detectBase(repo.main) };
  const pkgFile = join(repo.main, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    const pm = existsSync(join(repo.main, 'pnpm-lock.yaml')) ? 'pnpm'
      : existsSync(join(repo.main, 'yarn.lock')) ? 'yarn'
      : existsSync(join(repo.main, 'bun.lockb')) || existsSync(join(repo.main, 'bun.lock')) ? 'bun'
      : 'npm';
    suggestion.install = `${pm} install`;
    if (pkg.scripts?.dev) suggestion.run = `${pm} run dev`;
    else if (pkg.scripts?.start) suggestion.run = `${pm} start`;
  } else if (existsSync(join(repo.main, 'Cargo.toml'))) {
    suggestion.rebuild = 'cargo build';
    suggestion.run = `cargo run`;
  } else if (existsSync(join(repo.main, 'go.mod'))) {
    suggestion.rebuild = `go build -o .braid-bin/${basename(repo.main)} .`;
    suggestion.run = `./.braid-bin/${basename(repo.main)}`;
  }
  suggestion.remotePatterns = [];
  return suggestion;
}
