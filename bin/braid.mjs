#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_FILE, loadConfig, suggestConfig } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
import { ensurePreview } from '../src/preview.mjs';
import { openRepo } from '../src/repo.mjs';
import { matchesOff, readOff, readStatus, setPaused, summarize, writeOff } from '../src/status.mjs';
import { discoverLanes } from '../src/lanes.mjs';
import { runCommand } from '../src/runner.mjs';
import { out } from '../src/git.mjs';

const HELP = `braid: a live preview of every git worktree merged together

Usage: braid <command> [options]

Commands:
  init            Write ${CONFIG_FILE} (guessed from the project) and create the preview worktree
  up              Watch all worktrees, keep the preview merged and the app running
  merge           Merge once and update the preview, then exit
  status          Show the last merge result
  list | ls       Show every lane: live, conflict, off or pending, and where it comes from
  off <lane...>   Take lanes out of the preview (names or globs like 'origin/claude/*')
  on <lane...>    Put lanes back in (--all turns every lane back on)
  pause | resume  Stop or restart updating the preview (while \`up\` keeps running)

Options:
  --no-run        (up) Keep the preview updated but don't start the app
  --dry-run       (merge) Report what would be included without touching the preview
  --json          (list, status, merge) Print machine-readable output
`;

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
      console.log(`Wrote ${file}. Check "run", "rebuild" and "install" before running \`braid up\`.`);
    }
    const config = await loadConfig(repo);
    const base = await out(['rev-parse', `${config.base}^{commit}`], { cwd: repo.main });
    const { created } = await ensurePreview(repo, config, base);
    console.log(created ? `Created preview worktree at ${config.previewPath}` : `Preview worktree: ${config.previewPath}`);
    if (created && config.install) {
      console.log(`Installing dependencies in the preview (${config.install})…`);
      const { code } = await runCommand(config.install, config.previewPath, (line) => console.log(`[install] ${line}`));
      if (code !== 0) console.log('Install failed; `braid up` will retry when dependencies change.');
    }
    return 0;
  }

  if (command === 'status') {
    const status = readStatus(repo);
    console.log(flags.has('--json') ? JSON.stringify(status, null, 2) : summarize(status));
    if (status && !flags.has('--json')) {
      for (const lane of status.lanes) {
        const detail = lane.status === 'included' || lane.status === 'off' ? '' : ` (${lane.conflicts?.length ? `conflict in ${lane.conflicts.join(', ')}` : lane.reason})`;
        console.log(`  ${lane.status.padEnd(8)} ${lane.name}${detail}`);
      }
      if (status.build?.state === 'failed') console.log(`\n${status.build.step} output:\n${status.build.output}`);
    }
    return 0;
  }

  if (command === 'pause' || command === 'resume') {
    setPaused(repo, command === 'pause');
    console.log(command === 'pause' ? 'Paused: the preview will stop updating.' : 'Resumed.');
    return 0;
  }

  const config = await loadConfig(repo);

  if (command === 'list' || command === 'ls' || command === 'on' || command === 'off') {
    const names = rest.filter((a) => !a.startsWith('--'));
    const lanes = await discoverLanes(repo, config);
    let off = readOff(repo);
    if (command === 'off') {
      if (!names.length) throw new Error('Name at least one lane to turn off (see `braid list`).');
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
    // off (switched off), pending (on, not merged yet: `braid up` isn't running or hasn't caught up).
    const rows = lanes.map((lane) => {
      const last = status?.lanes.find((l) => l.name === lane.name);
      const state = matchesOff(lane.name, off) ? 'off'
        : !last || last.status === 'off' ? 'pending'
        : last.status === 'included' ? 'live'
        : last.status === 'excluded' ? 'conflict'
        : 'error';
      const detail = state === 'conflict' ? last.conflicts.join(', ') : state === 'error' ? last.reason : '';
      return { name: lane.name, state, kind: lane.kind, source: lane.path || lane.ref.replace(/^refs\/remotes\//, 'remote '), detail };
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
    console.log(`\n${live} of ${rows.length} lanes live${status ? ` · preview @ ${status.merged?.slice(0, 7)} on ${status.base.name}` : ' · no merge yet (run `braid up`)'}`);
    if ((command === 'on' || command === 'off') && status) console.log('A running `braid up` picks this up within a couple of seconds.');
    return 0;
  }

  if (command === 'merge') {
    const json = flags.has('--json');
    const engine = new Engine(repo, config, { run: false, update: !flags.has('--dry-run'), log: json ? () => {} : console.log });
    const status = await engine.cycle({ force: true });
    if (json) console.log(JSON.stringify(status, null, 2));
    return status?.lanes.some((l) => l.status !== 'included' && l.status !== 'off') ? 1 : 0;
  }

  if (command === 'up') {
    const engine = new Engine(repo, config, { run: !flags.has('--no-run') });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\n[braid] stopping…');
      await engine.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log(`[braid] previewing ${config.base} + all worktrees in ${config.previewPath}`);
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
    console.error(`braid: ${error.message}`);
    process.exit(1);
  },
);
