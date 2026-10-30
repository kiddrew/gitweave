import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY, git, out } from './git.mjs';
import { listWorktrees, realpathMaybe } from './repo.mjs';

const TAIL = 4000;
const MARKERS = /^(<{7}|={7}|>{7})( |$)/m;

export const DEFAULT_RESOLVER = 'claude -p "$GITWEAVE_PROMPT" --permission-mode acceptEdits --allowedTools "Read Edit Write Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git show:*)"';

export const resolveWorktreePath = (config) => `${config.previewPath}-resolve`;
const resolutionsDir = (repo) => join(repo.stateDir, 'resolutions');

// A conflict is identified by exactly what collided: each conflicted path's
// base/ours/theirs blobs (from `git merge-tree`). The same collision, however
// the rest of either side changes, reuses the same resolution.
export function conflictKey(stages) {
  return createHash('sha256').update(stages.map((s) => `${s.mode} ${s.oid} ${s.stage}\t${s.path}`).sort().join('\n')).digest('hex').slice(0, 24);
}

export function parseStages(lines) {
  return lines.map((line) => line.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/)).filter(Boolean)
    .map(([, mode, oid, stage, path]) => ({ mode, oid, stage: Number(stage), path }));
}

// path -> { mode, oid } (oid null: the resolution deletes the file).
export function loadResolution(repo, key) {
  const file = join(resolutionsDir(repo), `${key}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// The merged tree with each conflicted path replaced by its resolved content.
export async function applyResolution(repo, tree, resolution) {
  const env = { GIT_INDEX_FILE: join(repo.stateDir, 'resolve.index') };
  const cwd = repo.main;
  await git(['read-tree', tree], { cwd, env });
  for (const [path, entry] of Object.entries(resolution.files)) {
    if (entry.oid) await git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`], { cwd, env });
    else await git(['update-index', '--force-remove', '--', path], { cwd, env });
  }
  const result = await out(['write-tree'], { cwd, env });
  rmSync(env.GIT_INDEX_FILE, { force: true });
  return result;
}

function run(command, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (d) => (output = (output + d).slice(-TAIL));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function prompt(job) {
  return [
    `This git working tree is in the middle of merging the lane "${job.lane}" into the combined preview of all lanes.`,
    `These files have conflict markers: ${job.paths.join(', ')}.`,
    'Resolve every conflict so the result keeps the intent of both sides: the lane\'s changes and the changes already in the preview.',
    'Read the surrounding code and both sides\' history (git log/diff/show) as needed. Remove all conflict markers.',
    'Only edit the conflicted files. Do not commit, stage, or run other git commands that change state.',
  ].join('\n');
}

// Resolves conflicting lanes in the background, one at a time, in a private
// worktree next to the preview. Source worktrees and branches are never
// touched; the result is cached by conflictKey and applied in memory.
export class Resolver {
  constructor(repo, config, { log = () => {}, onDone = () => {} } = {}) {
    this.repo = repo;
    this.config = config;
    this.log = log;
    this.onDone = onDone;
    this.dir = resolveWorktreePath(config);
    this.queue = new Map();
    this.state = new Map(); // key -> { state: 'resolving' | 'failed', reason }
    this.running = null;
    this.stopped = false;
  }

  status(key) {
    return this.state.get(key) || (this.queue.has(key) ? { state: 'queued' } : null);
  }

  // job: { key, lane, ours (commit), theirs (commit), paths }
  request(job) {
    if (this.stopped || this.state.has(job.key) || this.queue.has(job.key)) return;
    // Only the newest collision per lane matters.
    for (const [key, queued] of this.queue) if (queued.lane === job.lane) this.queue.delete(key);
    this.queue.set(job.key, job);
    this.next();
  }

  next() {
    if (this.running || this.stopped || !this.queue.size) return;
    const [key, job] = this.queue.entries().next().value;
    this.queue.delete(key);
    this.state.set(key, { state: 'resolving' });
    this.running = this.resolve(job).finally(() => {
      this.running = null;
      this.next();
    });
  }

  async ensureWorktree() {
    const worktrees = await listWorktrees(this.repo.main);
    if (worktrees.some((wt) => realpathMaybe(wt.path) === realpathMaybe(this.dir))) return;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, '..'), { recursive: true });
    await git(['worktree', 'add', '--detach', '--quiet', this.dir, 'HEAD'], { cwd: this.repo.main });
  }

  async resolve(job) {
    const cwd = this.dir;
    try {
      this.log(`resolving ${job.lane} (${job.paths.join(', ')})`);
      await this.ensureWorktree();
      await git(['merge', '--abort'], { cwd, ok: [0, 128] });
      await git(['reset', '--hard', '--quiet', job.ours], { cwd });
      await git(['clean', '-fdq'], { cwd });
      await git(['merge', '--no-commit', '--no-ff', '--quiet', job.theirs], { cwd, env: IDENTITY, ok: [0, 1] });
      const result = await run(this.config.resolveCommand, cwd, { GITWEAVE_PROMPT: prompt(job), GITWEAVE_FILES: job.paths.join('\n'), GITWEAVE_LANE: job.lane });
      if (result.code !== 0) throw new Error(`resolver exited ${result.code}: ${result.output.trim().split('\n').pop() || ''}`);
      const files = {};
      for (const path of job.paths) {
        const full = join(cwd, path);
        if (!existsSync(full)) {
          files[path] = { oid: null };
          continue;
        }
        if (MARKERS.test(readFileSync(full, 'utf8'))) throw new Error(`conflict markers left in ${path}`);
        const mode = (await out(['ls-files', '-s', '--', path], { cwd })).split(' ')[0] || '100644';
        files[path] = { mode, oid: await out(['hash-object', '-w', '--', path], { cwd }) };
      }
      // Keep the blobs reachable so `git gc` doesn't drop them.
      const tree = await this.keepTree(files);
      await git(['update-ref', `refs/gitweave/resolved/${job.key}`, await out(['commit-tree', tree, '-m', `gitweave: resolve ${job.lane}`], { cwd, env: IDENTITY })], { cwd });
      mkdirSync(resolutionsDir(this.repo), { recursive: true });
      writeFileSync(join(resolutionsDir(this.repo), `${job.key}.json`), JSON.stringify({ lane: job.lane, at: new Date().toISOString(), files }, null, 2));
      this.state.delete(job.key);
      this.log(`resolved ${job.lane}`);
      this.onDone(job);
    } catch (error) {
      this.state.set(job.key, { state: 'failed', reason: error.message.split('\n')[0] });
      this.log(`could not resolve ${job.lane}: ${error.message.split('\n')[0]}`);
      this.onDone(job);
    } finally {
      await git(['merge', '--abort'], { cwd, ok: [0, 128] }).catch(() => {});
    }
  }

  async keepTree(files) {
    const env = { GIT_INDEX_FILE: join(this.repo.stateDir, 'resolve-keep.index') };
    rmSync(env.GIT_INDEX_FILE, { force: true });
    for (const [path, entry] of Object.entries(files)) {
      if (entry.oid) await git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`], { cwd: this.repo.main, env });
    }
    const tree = await out(['write-tree'], { cwd: this.repo.main, env });
    rmSync(env.GIT_INDEX_FILE, { force: true });
    return tree;
  }

  async stop() {
    this.stopped = true;
    this.queue.clear();
    if (this.running) await this.running;
  }
}
