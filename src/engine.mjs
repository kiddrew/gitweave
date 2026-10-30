import { existsSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { git, out } from './git.mjs';
import { discoverLanes } from './lanes.mjs';
import { snapshotWorktree, resolveRemote } from './snapshot.mjs';
import { integrate } from './merge.mjs';
import { ensurePreview, updatePreview } from './preview.mjs';
import { AppRunner, runCommand } from './runner.mjs';
import { AnyshipDeployer } from './anyship.mjs';
import { expandScript, portlessCommand, portlessName, portlessUrl } from './portless.mjs';
import { syncPullRequests } from './prs.mjs';
import { Resolver } from './resolve.mjs';
import { isPaused, matchesOff, readOff, readStatus, remotePatterns, summarize, writeStatus } from './status.mjs';

const stamp = () => new Date().toLocaleTimeString();

export class Engine {
  constructor(repo, config, { log = console.log, appLog, run = true, update = true, deploy = false, resolveConflicts = deploy } = {}) {
    this.repo = repo;
    this.config = config;
    this.log = (msg) => log(`[gitweave ${stamp()}] ${msg}`);
    this.appLog = appLog || ((line) => log(`[app] ${line}`));
    this.update = update;
    this.snapshots = new Map();
    this.dirty = new Set();
    this.allDirty = true;
    this.lastKey = null;
    this.lastStatus = null;
    this.build = { state: 'idle' };
    this.app = { state: 'stopped' };
    this.cycles = 0;
    this.running = false;
    this.pending = false;
    this.watchers = new Map();
    this.timers = [];
    this.settleTimer = null;
    this.signature = null;
    this.runner = run && config.run && update
      ? new AppRunner(config.run, config.previewPath, { onLine: (line) => this.onAppLine(line), onState: (s) => this.onAppState(s) })
      : null;
    // Conflicting lanes are resolved in the background; the next pass applies the result.
    this.resolver = resolveConflicts && config.resolve && update
      ? new Resolver(repo, config, { log: this.log, onDone: () => this.trigger({ force: true }) })
      : null;
    this.deployer = deploy && config.anyship && update
      ? new AnyshipDeployer(repo, config, {
        log: this.log,
        isPaused: () => isPaused(repo),
        last: readStatus(repo)?.anyship,
        onState: (anyship) => this.lastStatus && this.writeStatus({ ...this.lastStatus, anyship }),
      })
      : null;
  }

  // Without portless the app picks its own port, so take the first local URL
  // its dev server prints after each start (`Local: http://localhost:5173/`).
  onAppLine(line) {
    this.appLog(line);
    if (this.portless || this.detectedUrl) return;
    const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s]*/);
    if (!match) return;
    this.detectedUrl = true;
    this.local = match[0].replace('0.0.0.0', 'localhost').replace(/[).,]+$/, '');
    this.log(`app at ${this.local}`);
    if (this.lastStatus) this.writeStatus({ ...this.lastStatus, local: this.local });
  }

  onAppState(state) {
    this.app = state;
    if (state.state === 'running') this.detectedUrl = false;
    if (state.state === 'crashed') this.log(`app exited (${state.signal || state.code}); restarting in ${state.restartInMs / 1000}s`);
  }

  // One full pass: snapshot changed lanes, merge, update the preview, rebuild.
  // Returns the status, or null when nothing changed since the last pass.
  async cycle({ force = false } = {}) {
    const { repo, config } = this;
    const base = await out(['rev-parse', '--verify', `${config.base}^{commit}`], { cwd: repo.main });
    if (isPaused(repo)) {
      this.writeStatus({ ...(this.lastStatus || this.emptyStatus(base)), paused: true, updatedAt: new Date().toISOString() });
      return null;
    }

    const lanes = await discoverLanes(repo, config);
    const off = readOff(repo);
    for (const lane of lanes) {
      if (matchesOff(lane.name, off)) {
        lane.off = true;
        continue;
      }
      if (lane.stale) continue;
      try {
        if (lane.kind === 'remote' || lane.kind === 'pr') Object.assign(lane, await resolveRemote(repo, lane));
        else if (this.allDirty || this.dirty.has(lane.name) || !this.snapshots.has(lane.name)) {
          const snap = await snapshotWorktree(repo, lane, this.snapshots.get(lane.name));
          this.snapshots.set(lane.name, snap);
          Object.assign(lane, snap);
        } else Object.assign(lane, this.snapshots.get(lane.name));
      } catch (error) {
        lane.error = (error.stderr || error.message).trim().split('\n')[0];
      }
    }
    for (const name of this.snapshots.keys()) if (!lanes.some((l) => l.name === name)) this.snapshots.delete(name);
    this.dirty.clear();
    this.allDirty = false;

    const key = [base, ...lanes.map((l) => `${l.name}:${l.off ? 'off' : l.stale ? 'stale' : l.commit || l.error}`)].join('|');
    if (key === this.lastKey && !force) return null;
    this.lastKey = key;
    this.cycles++;

    const result = await integrate(repo.main, base, lanes, { repo });
    for (const lane of result.lanes) {
      if (!lane.resolve) continue;
      const { key, ours, theirs } = lane.resolve;
      delete lane.resolve;
      if (!this.resolver) continue;
      this.resolver.request({ key, lane: lane.name, ours, theirs, paths: lane.conflicts });
      const state = this.resolver.status(key);
      if (state) lane.resolving = state.state === 'failed' ? { state: 'failed', reason: state.reason } : { state: 'resolving' };
    }
    const status = {
      updatedAt: new Date().toISOString(),
      base: { name: config.base, commit: base },
      merged: result.commit,
      previewPath: config.previewPath,
      lanes: result.lanes,
      build: this.build,
      app: this.app,
      paused: false,
      local: this.local,
      anyship: this.deployer?.state,
    };

    if (this.update) {
      const { created } = await ensurePreview(repo, config, base);
      const applied = await updatePreview(repo, config, result.commit);
      status.changed = applied.changed;
      // A failed install (here or in `init`) is retried on the next pass, not only when dependencies change.
      const reinstall = Boolean(config.install) && !existsSync(this.installedFile());
      if (created || reinstall || applied.depsChanged || applied.changed.length || applied.copied.length) {
        await this.afterUpdate({ created, ...applied, depsChanged: applied.depsChanged || reinstall });
      }
      status.build = this.build;
      status.app = this.app;
    }
    this.writeStatus(status);
    this.log(summarize(status, { time: false }));
    // Runs in the background; never holds up the local preview or the app.
    this.deployer?.schedule(result.commit, base);
    return status;
  }

  async afterUpdate({ created, depsChanged, changed }) {
    const { config } = this;
    const cwd = config.previewPath;
    let restart = false;
    if ((created || depsChanged) && config.install) {
      this.log(`installing dependencies (${config.install})`);
      const install = await runCommand(config.install, cwd, this.appLog);
      if (install.code !== 0) {
        rmSync(this.installedFile(), { force: true });
        this.build = { state: 'failed', step: 'install', at: new Date().toISOString(), output: install.output };
        return;
      }
      writeFileSync(this.installedFile(), new Date().toISOString());
      restart = true;
    }
    if (config.rebuild && (created || changed.length || depsChanged)) {
      this.build = { state: 'building', at: new Date().toISOString() };
      const build = await runCommand(config.rebuild, cwd, this.appLog);
      if (build.code !== 0) {
        // Keep the last good app running; the failure shows in status.
        this.build = { state: 'failed', step: 'rebuild', at: new Date().toISOString(), output: build.output };
        return;
      }
      restart = true;
    }
    this.build = { state: 'ok', at: new Date().toISOString() };
    // An in-flight pass can finish after stop(); it must not relaunch the app.
    if (!this.runner || this.stopped) return;
    if (restart || !this.runner.child) await this.runner.restart();
  }

  installedFile() {
    return join(this.repo.stateDir, 'installed');
  }

  emptyStatus(base) {
    return { updatedAt: new Date().toISOString(), base: { name: this.config.base, commit: base }, merged: null, previewPath: this.config.previewPath, lanes: [], build: this.build, app: this.app };
  }

  writeStatus(status) {
    if (this.deployer) status = { ...status, anyship: this.deployer.state };
    this.lastStatus = status;
    writeStatus(this.repo, status);
  }

  // Serialize passes: a change during a pass queues exactly one follow-up.
  async trigger(opts) {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      // A forced follow-up (e.g. a resolution just landed) must stay forced.
      this.pendingForce ||= Boolean(opts?.force);
      return;
    }
    this.running = true;
    try {
      await this.cycle(opts);
    } catch (error) {
      this.log(`error: ${error.message}`);
    } finally {
      this.running = false;
    }
    if (this.pending && !this.stopped) {
      const force = this.pendingForce;
      this.pending = false;
      this.pendingForce = false;
      await this.trigger({ force });
    }
  }

  markDirty(name) {
    if (this.stopped) return;
    this.dirty.add(name);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.trigger(), this.config.settleMs);
  }

  ignored(filename) {
    if (!filename) return false;
    return filename.split(/[\\/]/).some((part) => this.config.ignore.includes(part));
  }

  async syncWatchers() {
    const lanes = (await discoverLanes(this.repo, this.config)).filter((l) => l.kind === 'worktree');
    // A poll in flight during stop() must not reopen watchers (they'd keep the process alive).
    if (this.stopped) return;
    const wanted = new Map(lanes.map((l) => [l.path, l.name]));
    for (const [path, watcher] of this.watchers) {
      if (!wanted.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
    for (const [path, name] of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { recursive: true }, (_event, filename) => {
          if (!this.ignored(filename ? String(filename).split(sep).join('/') : null)) this.markDirty(name);
        });
        watcher.on('error', () => this.markDirty(name));
        this.watchers.set(path, watcher);
      } catch (error) {
        this.log(`cannot watch ${path}: ${error.message}`);
      }
    }
  }

  // Cheap check for things file watching can't see: the base moving, worktrees
  // added/removed or switching commits, remote lanes moving, pause toggling.
  async computeSignature() {
    const parts = [
      await out(['rev-parse', `${this.config.base}^{commit}`], { cwd: this.repo.main }),
      await out(['worktree', 'list', '--porcelain'], { cwd: this.repo.main }),
      String(isPaused(this.repo)),
      readOff(this.repo).join('\n'),
    ];
    const patterns = remotePatterns(this.repo, this.config);
    parts.push(patterns.join('\n'));
    parts.push(await out(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/gitweave/pr/'], { cwd: this.repo.main }));
    for (const pattern of patterns) {
      parts.push(await out(['for-each-ref', '--format=%(refname) %(objectname)', `refs/remotes/${pattern}`], { cwd: this.repo.main }));
    }
    return parts.join('\n');
  }

  async poll() {
    try {
      const signature = await this.computeSignature();
      if (signature === this.signature || this.stopped) return;
      this.signature = signature;
      await this.syncWatchers();
      this.allDirty = true;
      await this.trigger();
    } catch (error) {
      this.log(`poll error: ${error.message}`);
    }
  }

  async fetch() {
    if (this.config.prs) {
      try {
        await syncPullRequests(this.repo);
        this.prError = null;
      } catch (error) {
        // Usually gh missing or signed out, or a repo not on GitHub; say so once.
        if (this.prError !== error.message) this.log(`pull requests unavailable: ${error.message}`);
        this.prError = error.message;
      }
    }
    if (!remotePatterns(this.repo, this.config).length) return;
    const { code, stderr } = await git(['fetch', '--all', '--prune', '--quiet'], { cwd: this.repo.main, ok: [0, 1, 128] });
    if (code !== 0) this.log(`fetch failed: ${stderr.trim().split('\n')[0]}`);
  }

  // Route a stable https://<name>.localhost to the app instead of a raw port.
  async setupPortless() {
    const name = portlessName(this.repo, this.config);
    const url = await portlessUrl(name);
    if (!url) {
      this.log('portless not found; running the app on its own port');
      return;
    }
    this.runner.command = portlessCommand(name, expandScript(this.config.run, this.config.previewPath));
    this.portless = true;
    this.local = url;
    this.log(`app at ${url}`);
  }

  async start() {
    this.stopped = false;
    if (this.config.portless && this.runner) await this.setupPortless();
    this.signature = await this.computeSignature();
    await this.syncWatchers();
    await this.trigger({ force: true });
    if (this.runner && !this.runner.child && this.build.state !== 'failed') this.runner.start();
    this.timers.push(setInterval(() => this.poll(), this.config.pollMs));
    // Always armed: `gitweave add` can introduce remote lanes while this runs.
    if (this.config.fetchIntervalSec > 0) {
      this.fetch().then(() => this.poll());
      this.timers.push(setInterval(() => this.fetch().then(() => this.poll()), this.config.fetchIntervalSec * 1000));
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.settleTimer);
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.resolver?.stop();
    while (this.running) await new Promise((r) => setTimeout(r, 20));
    await this.deployer?.stop();
    if (this.runner) {
      this.runner.closed = true;
      await this.runner.stop();
    }
  }
}
