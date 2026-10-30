import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { git, out } from './git.mjs';
import { listWorktrees, realpathMaybe } from './repo.mjs';

export const CONFIG_FILE = 'gitweave.json';

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
  copy: ['.env', '.env.local', '.dev.vars', 'pnpm-workspace.yaml', '.npmrc'],
  settleMs: 1500,
  pollMs: 2000,
  fetchIntervalSec: 60,
  staleDays: 30,
  prs: true,
  portless: true,
  anyship: false,
  anyshipReviewApp: 'integration',
  anyshipDebounceSec: 30,
};

export async function detectBase(cwd) {
  for (const name of ['main', 'master']) {
    const { code } = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd, ok: [0, 1] });
    if (code === 0) return name;
  }
  const remoteHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, ok: [0, 1] });
  if (remoteHead.code === 0) return remoteHead.stdout.trim();
  throw new Error('Could not detect a base branch. Set "base" in gitweave.json.');
}

// Outside every repo, so watchers, editors and git's upward search skip it.
// The short hash keeps two repos with the same folder name apart.
export const gitweaveHome = () => process.env.GITWEAVE_HOME || join(homedir(), '.gitweave');

export function defaultPreviewPath(repo) {
  const id = createHash('sha256').update(realpathMaybe(repo.main)).digest('hex').slice(0, 8);
  return join(gitweaveHome(), `${basename(repo.main)}-${id}`, 'preview');
}

// Earlier versions kept the preview in .git/gitweave/preview; keep using it if it's still there.
async function legacyPreviewPath(repo) {
  const legacy = join(repo.stateDir, 'preview');
  const worktrees = await listWorktrees(repo.main);
  return worktrees.some((wt) => realpathMaybe(wt.path) === realpathMaybe(legacy)) ? legacy : null;
}

const expandHome = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

export async function loadConfig(repo, overrides = {}) {
  const file = join(repo.main, CONFIG_FILE);
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const config = { ...DEFAULTS, ...fromFile, ...overrides };
  config.base ||= await detectBase(repo.main);
  config.previewPath = resolve(repo.main, expandHome(config.previewPath || (await legacyPreviewPath(repo)) || defaultPreviewPath(repo)));
  await out(['rev-parse', '--verify', `${config.base}^{commit}`], { cwd: repo.main }).catch(() => {
    throw new Error(`Base "${config.base}" does not resolve to a commit.`);
  });
  return config;
}

// A starting config guessed from the project, written by `gitweave init`.
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
    suggestion.rebuild = `go build -o .gitweave-bin/${basename(repo.main)} .`;
    suggestion.run = `./.gitweave-bin/${basename(repo.main)}`;
  }
  suggestion.remotePatterns = [];
  return suggestion;
}
