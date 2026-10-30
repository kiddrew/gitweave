#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { CONFIG_FILE, loadConfig, suggestConfig } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
import { copyLocalFiles, ensurePreview } from '../src/preview.mjs';
import { openRepo } from '../src/repo.mjs';
import { anyshipLine, matchesOff, readOff, readRemotes, readStatus, setPaused, summarize, writeOff, writeRemotes } from '../src/status.mjs';
import { discoverLanes } from '../src/lanes.mjs';
import { runCommand } from '../src/runner.mjs';
import { git, out } from '../src/git.mjs';

const HELP = `gitweave: a live preview of every git worktree merged together

Usage: gitweave <command> [options]

Commands:
  init            Write ${CONFIG_FILE} (guessed from the project) and create the preview worktree
  up              Start in the background: watch all worktrees, keep the preview merged and the app running
  down            Stop the background gitweave
  logs [-f]       Show (or follow) the background gitweave's log
  merge           Merge once and update the preview, then exit
  status          Show the last merge result
  list | ls       Show every lane: live, conflict, off or pending, and where it comes from
  add <branch...> Include remote branches as lanes ('feature-x', 'origin/feature-x' or globs like 'origin/claude/*');
                  --all includes every remote branch, and new ones as they're pushed
  remove <branch...>  Stop including remote branches added with \`add\` (--all removes every remote glob)
  off <lane...>   Take lanes out of the preview (names or globs like 'origin/claude/*')
  on <lane...>    Put lanes back in (--all turns every lane back on)
  pause | resume  Stop or restart updating the preview and Anyship deploys (while \`up\` keeps running)

Options:
  --foreground    (up) Run in this terminal instead of the background
  --no-run        (up) Keep the preview updated but don't start the app
  --anyship       (up) Also deploy the merged preview to Anyship (same as "anyship": true)
  --dry-run       (merge) Report what would be included without touching the preview
  --json          (list, status, merge) Print machine-readable output
`;

const pidFile = (repo) => join(repo.stateDir, 'up.pid');
const logFile = (repo) => join(repo.stateDir, 'up.log');

// The pid of the background `gitweave up` for this repo, if it's alive.
function runningPid(repo) {
  if (!existsSync(pidFile(repo))) return null;
  const pid = Number(readFileSync(pidFile(repo), 'utf8'));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    rmSync(pidFile(repo), { force: true });
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  if (command === 'help' || flags.has('--help') || command === '-h' || command === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  const repo = await openRepo(process.cwd());

  if (command === 'init') {
    const file = join(repo.main, CONFIG_FILE);
    if (existsSync(file)) console.log(`${CONFIG_FILE} already exists; leaving it as is.`);
    else {
      writeFileSync(file, JSON.stringify(await suggestConfig(repo), null, 2) + '\n');
      console.log(`Wrote ${file}. Check "run", "rebuild" and "install" before running \`gitweave up\`.`);
    }
    const config = await loadConfig(repo);
    const base = await out(['rev-parse', `${config.base}^{commit}`], { cwd: repo.main });
    const { created } = await ensurePreview(repo, config, base);
    console.log(created ? `Created preview worktree at ${config.previewPath}` : `Preview worktree: ${config.previewPath}`);
    await copyLocalFiles(repo, config);
    if (created && config.install) {
      console.log(`Installing dependencies in the preview (${config.install})…`);
      const { code } = await runCommand(config.install, config.previewPath, (line) => console.log(`[install] ${line}`));
      if (code === 0) writeFileSync(join(repo.stateDir, 'installed'), new Date().toISOString());
      else console.log('Install failed; `gitweave up` will retry it.');
    }
    return 0;
  }

  if (command === 'status') {
    const status = readStatus(repo);
    console.log(flags.has('--json') ? JSON.stringify(status, null, 2) : summarize(status));
    if (!flags.has('--json')) console.log(runningPid(repo) ? `running in the background (pid ${runningPid(repo)})` : 'not running (`gitweave up` starts it)');
    if (status && !flags.has('--json')) {
      for (const lane of status.lanes) {
        const detail = lane.resolved?.length ? ` (resolved: ${lane.resolved.join(', ')})` : ['included', 'off'].includes(lane.status) ? '' : lane.resolving?.state === 'resolving' ? ` (resolving conflicts in ${lane.conflicts.join(', ')})` : ` (${lane.conflicts?.length ? `conflict in ${lane.conflicts.join(', ')}` : lane.reason})`;
        console.log(`  ${lane.status.padEnd(8)} ${lane.name}${detail}`);
      }
      if (status.anyship) console.log(anyshipLine(status.anyship));
      if (status.build?.state === 'failed') console.log(`\n${status.build.step} output:\n${status.build.output}`);
    }
    return 0;
  }

  if (command === 'down') {
    const pid = runningPid(repo);
    if (!pid) {
      console.log('gitweave is not running for this repo.');
      return 0;
    }
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100 && runningPid(repo); i++) await sleep(100);
    if (runningPid(repo)) {
      process.kill(pid, 'SIGKILL');
      rmSync(pidFile(repo), { force: true });
    }
    console.log(`Stopped gitweave (pid ${pid}).`);
    return 0;
  }

  if (command === 'logs') {
    if (!existsSync(logFile(repo))) {
      console.log('No log yet. Start gitweave with `gitweave up`.');
      return 0;
    }
    if (!flags.has('--follow') && !rest.includes('-f')) {
      process.stdout.write(readFileSync(logFile(repo), 'utf8').split('\n').slice(-200).join('\n'));
      return 0;
    }
    spawn('tail', ['-n', '200', '-f', logFile(repo)], { stdio: 'inherit' });
    return null;
  }

  if (command === 'pause' || command === 'resume') {
    setPaused(repo, command === 'pause');
    console.log(command === 'pause' ? 'Paused: the preview will stop updating.' : 'Resumed.');
    return 0;
  }

  const config = await loadConfig(repo, command === 'up' && flags.has('--anyship') ? { anyship: true } : {});

  if (command === 'add' || command === 'remove' || command === 'rm') {
    const remotes = (await out(['remote'], { cwd: repo.main })).split('\n').filter(Boolean);
    if (!remotes.length) throw new Error('This repository has no remotes.');
    // --all: every branch on every remote, including ones pushed later.
    const names = flags.has('--all') ? remotes.map((r) => `${r}/*`) : rest.filter((a) => !a.startsWith('--'));
    if (!names.length) throw new Error(`Name at least one remote branch to ${command === 'add' ? 'add' : 'remove'}, or pass --all.`);
    // `feature-x` means the branch on origin (or the only remote).
    const fallback = remotes.includes('origin') ? 'origin' : remotes[0];
    const qualify = (name) => (remotes.some((r) => name.startsWith(`${r}/`)) ? name : `${fallback}/${name}`);
    const patterns = names.map(qualify);
    if (command === 'add') {
      writeRemotes(repo, [...readRemotes(repo), ...patterns]);
      for (const remote of new Set(patterns.map((p) => p.split('/')[0]))) {
        const { code, stderr } = await git(['fetch', '--prune', '--quiet', remote], { cwd: repo.main, ok: [0, 1, 128] });
        if (code !== 0) console.log(`fetch ${remote} failed: ${stderr.trim().split('\n')[0]}`);
      }
      for (const pattern of patterns) {
        const refs = await out(['for-each-ref', '--format=%(refname)', `refs/remotes/${pattern}`], { cwd: repo.main });
        console.log(refs ? `added ${pattern}` : `added ${pattern} (no such branch yet; it will apply once one is pushed)`);
      }
    } else {
      const stored = readRemotes(repo);
      writeRemotes(repo, stored.filter((entry) => !patterns.includes(entry)));
      for (const pattern of patterns) {
        if (stored.includes(pattern)) console.log(`removed ${pattern}`);
        else if (config.remotePatterns.includes(pattern)) console.log(`${pattern} comes from "remotePatterns" in ${CONFIG_FILE}; remove it there.`);
        else console.log(`${pattern} wasn't added.`);
      }
    }
    console.log('A running `gitweave up` picks this up within a couple of seconds.');
    return 0;
  }

  if (command === 'list' || command === 'ls' || command === 'on' || command === 'off') {
    const names = rest.filter((a) => !a.startsWith('--'));
    const lanes = await discoverLanes(repo, config);
    let off = readOff(repo);
    if (command === 'off') {
      if (!names.length) throw new Error('Name at least one lane to turn off (see `gitweave list`).');
      off = writeOff(repo, [...off, ...names]);
    } else if (command === 'on') {
      if (!names.length && !flags.has('--all')) throw new Error('Name at least one lane to turn on, or pass --all.');
      // Turning on a lane that's covered by a glob means removing that glob.
      off = writeOff(repo, flags.has('--all') ? [] : off.filter((entry) => !names.some((n) => matchesOff(n, [entry]))));
    }
    for (const name of names) {
      if (!lanes.some((l) => matchesOff(l.name, [name]))) console.log(`note: "${name}" doesn't match a current lane${command === 'off' ? '; it will apply if one appears' : ''}.`);
    }
    const status = readStatus(repo);
    // State per lane: live (in the preview now), conflict/error (on but left out),
    // off (switched off), stale (remote branch with no recent commits, skipped),
    // pending (on, not merged yet: `gitweave up` isn't running or hasn't caught up).
    const rows = lanes.map((lane) => {
      const last = status?.lanes.find((l) => l.name === lane.name);
      const state = matchesOff(lane.name, off) ? 'off'
        : lane.stale ? 'stale'
        : !last || last.status === 'off' ? 'pending'
        : last.status === 'included' ? 'live'
        : last.status === 'excluded' && last.resolving?.state === 'resolving' ? 'resolving'
        : last.status === 'excluded' ? 'conflict'
        : 'error';
      const detail = state === 'conflict' ? `${last.conflicts.join(', ')}${last.resolving?.state === 'failed' ? `; auto-resolve failed: ${last.resolving.reason}` : ''}`
        : state === 'resolving' ? `resolving conflicts in ${last.conflicts.join(', ')}`
        : state === 'live' && last.resolved?.length ? `conflicts resolved by gitweave: ${last.resolved.join(', ')}`
        : state === 'error' ? last.reason
        : state === 'stale' ? `skipped: last commit ${lane.ageDays} days ago` : '';
      const source = lane.path || (lane.kind === 'pr' ? `PR #${lane.number} ${lane.branch}: ${lane.title}` : lane.ref.replace(/^refs\/remotes\//, 'remote '));
      return { name: lane.name, state, kind: lane.kind, source, detail };
    });
    if (flags.has('--json')) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    const width = Math.max(4, ...rows.map((r) => r.name.length));
    console.log(`  ${'STATE'.padEnd(9)}${'LANE'.padEnd(width + 2)}SOURCE`);
    const shortPath = (p) => {
      const rel = relative(process.cwd(), p) || '.';
      return rel.length < p.length ? rel : p;
    };
    for (const r of rows) {
      console.log(`  ${r.state.padEnd(9)}${r.name.padEnd(width + 2)}${r.kind === 'worktree' ? shortPath(r.source) : r.source}${r.detail ? `  (${r.state === 'conflict' ? 'conflict in ' : ''}${r.detail})` : ''}`);
    }
    const live = rows.filter((r) => r.state === 'live').length;
    const stale = rows.filter((r) => r.state === 'stale').length;
    console.log(`\n${live} of ${rows.length} lanes live${stale ? ` · ${stale} stale skipped (older than ${config.staleDays} days)` : ''}${status ? ` · preview @ ${status.merged?.slice(0, 7)} on ${status.base.name}` : ' · no merge yet (run `gitweave up`)'}`);
    if (!runningPid(repo)) console.log('gitweave is not running; `gitweave up` starts it.');
    console.log(`preview: ${shortPath(config.previewPath)}${status?.local ? ` · ${status.local}` : ''}`);
    if (config.anyship || status?.anyship) console.log(anyshipLine(status?.anyship));
    if ((command === 'on' || command === 'off') && status) console.log('A running `gitweave up` picks this up within a couple of seconds.');
    return 0;
  }

  if (command === 'merge') {
    const json = flags.has('--json');
    const engine = new Engine(repo, config, { run: false, update: !flags.has('--dry-run'), log: json ? () => {} : console.log });
    const status = await engine.cycle({ force: true });
    if (json) console.log(JSON.stringify(status, null, 2));
    return status?.lanes.some((l) => !['included', 'off', 'stale'].includes(l.status)) ? 1 : 0;
  }

  if (command === 'up' && !flags.has('--foreground')) {
    // Start in the background and return the terminal.
    const pid = runningPid(repo);
    if (pid) {
      console.log(`gitweave is already running (pid ${pid}). \`gitweave down\` stops it; \`gitweave logs -f\` follows it.`);
      return 0;
    }
    const startedAt = Date.now();
    const out = openSync(logFile(repo), 'w');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'up', '--foreground', ...rest], {
      cwd: process.cwd(), detached: true, stdio: ['ignore', out, out],
    });
    closeSync(out);
    child.unref();
    // Wait for the first merge so the user gets the result and URL right away.
    let status = null;
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      status = readStatus(repo);
      if (child.exitCode !== null) break;
      if (status && new Date(status.updatedAt).getTime() >= startedAt && (status.local || !config.run || i > 40)) break;
    }
    if (child.exitCode !== null || !runningPid(repo)) {
      console.log(`gitweave up exited:\n${readFileSync(logFile(repo), 'utf8').trim().split('\n').slice(-15).join('\n')}`);
      return 1;
    }
    console.log(`gitweave running in the background (pid ${child.pid})`);
    if (status && new Date(status.updatedAt).getTime() >= startedAt) console.log(summarize(status));
    console.log('`gitweave ls` shows lanes, `gitweave logs -f` follows the log, `gitweave down` stops it.');
    return 0;
  }

  if (command === 'up') {
    if (runningPid(repo) && runningPid(repo) !== process.pid) throw new Error(`gitweave is already running for this repo (pid ${runningPid(repo)}).`);
    writeFileSync(pidFile(repo), String(process.pid));
    const engine = new Engine(repo, config, { run: !flags.has('--no-run'), deploy: true });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\n[gitweave] stopping…');
      await engine.stop();
      if (runningPid(repo) === process.pid) rmSync(pidFile(repo), { force: true });
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log(`[gitweave] previewing ${config.base} + all worktrees in ${config.previewPath}`);
    if (config.anyship) console.log(`[gitweave] deploying to Anyship ${config.anyshipDebounceSec}s after changes settle`);
    await engine.start();
    return null;
  }

  console.error(`Unknown command: ${command}\n`);
  process.stdout.write(HELP);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => code !== null && process.exit(code),
  (error) => {
    console.error(`gitweave: ${error.message}`);
    process.exit(1);
  },
);
