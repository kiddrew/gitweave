import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

const TAIL = 4000;
const POLL_MS = 5000;
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

// Files that must never be uploaded; Anyship apps get settings from Anyship's own env config.
const SECRET = /^(\.env.*|\.dev\.vars.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*)$/;

const bin = () => process.env.GITWEAVE_ANYSHIP_BIN || 'anyship';

function runAnyship(args, cwd, timeout = DEPLOY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(bin(), args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr: stderr || (error && !stdout ? error.message : '') });
    });
  });
}

const firstLine = (text) => String(text || '').trim().split('\n').filter(Boolean).pop() || '';

// The main checkout's Anyship identity (written by its first `anyship deploy`),
// or the committed one. Only used to name the integration project.
export async function mainProject(repo, base) {
  const file = join(repo.main, '.anyship', 'project.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const { code, stdout } = await git(['show', `${base}:.anyship/project.json`], { cwd: repo.main, ok: [0, 128] });
  return code === 0 ? JSON.parse(stdout) : null;
}

function removeSecrets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SECRET.test(entry.name)) rmSync(path, { recursive: true, force: true });
    else if (entry.isDirectory()) removeSecrets(path);
  }
}

// Export the merged commit into a plain (non-git) folder next to the preview.
// It keeps its own .anyship/project.json, so deploys always target the
// integration project and never the repo's real one.
export async function exportTree(repo, commit, dir) {
  const manifestFile = join(dir, '.anyship', 'project.json');
  const manifest = existsSync(manifestFile) ? readFileSync(manifestFile) : null;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', commit], { cwd: repo.main, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    archive.stderr.on('data', (d) => (stderr += d));
    tar.stderr.on('data', (d) => (stderr += d));
    archive.stdout.pipe(tar.stdin);
    archive.on('error', reject);
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`export failed: ${stderr.trim()}`))));
  });
  rmSync(join(dir, '.anyship'), { recursive: true, force: true });
  removeSecrets(dir);
  if (manifest) {
    mkdirSync(join(dir, '.anyship'), { recursive: true });
    writeFileSync(manifestFile, manifest);
  }
  return Boolean(manifest);
}

// Deploys the merged preview to a dedicated Anyship project after a quiet
// period. At most one deploy runs; changes during it queue one follow-up for
// the newest commit. Never throws into the engine.
export class AnyshipDeployer {
  constructor(repo, config, { log = () => {}, onState = () => {}, isPaused = () => false, last = null } = {}) {
    this.repo = repo;
    this.config = config;
    this.log = log;
    this.onState = onState;
    this.isPaused = isPaused;
    this.dir = `${config.previewPath}-anyship`;
    this.state = last || { state: 'idle' };
    this.deployed = this.state.state === 'ok' ? this.state.commit : null;
    this.wanted = null;
    this.timer = null;
    this.running = null;
    this.queued = false;
    this.disabled = false;
    this.stopped = false;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  schedule(commit, base) {
    if (this.disabled || this.stopped || !commit) return;
    this.wanted = { commit, base };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.config.anyshipDebounceSec * 1000);
  }

  fire() {
    this.timer = null;
    if (this.stopped || !this.wanted) return;
    if (this.isPaused()) {
      // Try again once the pause lifts.
      this.timer = setTimeout(() => this.fire(), this.config.anyshipDebounceSec * 1000);
      return;
    }
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = this.deploy(this.wanted).finally(() => {
      this.running = null;
      if (this.queued && !this.stopped) {
        this.queued = false;
        this.fire();
      }
    });
  }

  async deploy({ commit, base }) {
    if (commit === this.deployed) return;
    try {
      const main = await mainProject(this.repo, base);
      if (!main?.app) {
        this.disabled = true;
        this.log('anyship: no .anyship/project.json in this repo. Deploy this project to Anyship once first; deploys are off.');
        this.setState({ state: 'failed', reason: 'no .anyship/project.json (deploy this project to Anyship once first)', at: new Date().toISOString() });
        return;
      }
      this.setState({ ...this.state, state: 'deploying', commit, at: new Date().toISOString(), reason: undefined });
      this.log(`anyship: deploying ${commit.slice(0, 7)}`);
      const confirmed = await exportTree(this.repo, commit, this.dir);
      const project = `${main.app}-${this.config.anyshipReviewApp}`;
      const args = confirmed ? ['deploy', '.'] : ['deploy', '--project', project, '.'];
      const run = await runAnyship(args, this.dir);
      if (run.code !== 0) return this.fail(commit, firstLine(run.stderr || run.stdout) || `deploy exited ${run.code}`);
      const result = await this.waitLive();
      if (result.error) return this.fail(commit, result.error);
      this.deployed = commit;
      this.setState({ state: 'ok', commit, at: new Date().toISOString(), url: result.url || this.state.url, project });
      this.log(`anyship: ${commit.slice(0, 7)} live at ${result.url}`);
    } catch (error) {
      this.fail(commit, error.message);
    }
  }

  fail(commit, reason) {
    this.log(`anyship: deploy of ${commit.slice(0, 7)} failed: ${reason}`);
    this.setState({ ...this.state, state: 'failed', commit, at: new Date().toISOString(), reason: String(reason).slice(0, TAIL) });
  }

  // Anyship builds after accepting the upload; poll until it settles.
  async waitLive() {
    const until = Date.now() + DEPLOY_TIMEOUT_MS;
    while (!this.stopped) {
      const run = await runAnyship(['status', '--json', '--path', '.'], this.dir, 60000);
      if (run.code !== 0) return { error: firstLine(run.stderr || run.stdout) || 'status failed' };
      let latest;
      try {
        latest = JSON.parse(run.stdout).latest;
      } catch {
        return { error: 'unreadable status output' };
      }
      if (latest?.status === 'deployed') return { url: latest.url };
      if (latest?.status === 'failed') return { error: latest.error || 'build failed' };
      if (Date.now() > until) return { error: 'timed out waiting for the build' };
      await new Promise((r) => setTimeout(r, Number(process.env.GITWEAVE_ANYSHIP_POLL_MS) || POLL_MS));
    }
    return { error: 'stopped' };
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.running) await this.running;
  }
}
