import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, out } from './git.mjs';

const PREFIX = 'refs/gitweave/pr/';
const bin = () => process.env.GITWEAVE_GH_BIN || 'gh';

export const prsFile = (repo) => join(repo.stateDir, 'prs.json');

// Open, non-draft pull requests last fetched by syncPullRequests.
export function readPullRequests(repo) {
  const file = prsFile(repo);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

function listOpen(cwd) {
  return new Promise((resolve, reject) => {
    execFile(bin(), ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,isDraft,isCrossRepository'], { cwd, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n')[0]));
      else resolve(JSON.parse(stdout));
    });
  });
}

// Ask GitHub (through `gh`) for open pull requests and fetch each non-draft
// one's head into refs/gitweave/pr/<number>. That ref works for PRs from forks
// too. Refs of PRs that closed or went back to draft are deleted.
export async function syncPullRequests(repo, remote = 'origin') {
  const prs = (await listOpen(repo.main)).filter((pr) => !pr.isDraft).sort((a, b) => a.number - b.number);
  if (prs.length) {
    const specs = prs.map((pr) => `+refs/pull/${pr.number}/head:${PREFIX}${pr.number}`);
    const { code, stderr } = await git(['fetch', '--quiet', '--no-tags', remote, ...specs], { cwd: repo.main, ok: [0, 1, 128] });
    if (code !== 0) throw new Error(`fetch failed: ${stderr.trim().split('\n')[0]}`);
  }
  const wanted = new Set(prs.map((pr) => `${PREFIX}${pr.number}`));
  for (const ref of (await out(['for-each-ref', '--format=%(refname)', PREFIX], { cwd: repo.main })).split('\n').filter(Boolean)) {
    if (!wanted.has(ref)) await git(['update-ref', '-d', ref], { cwd: repo.main });
  }
  const list = prs.map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, fork: pr.isCrossRepository }));
  writeFileSync(prsFile(repo), JSON.stringify(list, null, 2));
  return list;
}

export const prRef = (number) => `${PREFIX}${number}`;
