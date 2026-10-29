# gitweave

A live local preview of every git worktree merged together, including uncommitted edits, without merging anything into your branches.

Each worktree is a **lane**. Whenever a file is saved in any lane, gitweave snapshots that worktree's current files, merges the base branch plus every lane in memory, and updates a dedicated **preview worktree**. Your dev server runs there, so the page shows everyone's in-progress work combined. A lane that conflicts is left out and reported; the rest keep updating.

Source worktrees are never modified: no branch, index, stash or file changes.

Requires Node 20+ and git 2.38+. No dependencies.

## Use

```sh
cd your-repo
node path/to/gitweave/bin/gitweave.mjs init   # writes gitweave.json, creates the preview worktree in ~/.gitweave/<repo>-<id>/preview
node path/to/gitweave/bin/gitweave.mjs up     # watch, merge, run the app
```

| Command | What it does |
| --- | --- |
| `gitweave init` | Writes `gitweave.json` guessed from the project and creates the preview worktree |
| `gitweave up [--no-run] [--anyship]` | Watches every worktree, keeps the preview merged, runs and supervises the app; `--anyship` also deploys it (see below) |
| `gitweave merge [--dry-run] [--json]` | One merge, then exit (exit code 1 if any lane was excluded) |
| `gitweave list [--json]` (or `ls`) | Every lane with its state (`live`, `conflict`, `error`, `off`, `pending`) and source worktree or remote branch |
| `gitweave off <lane...>` | Take lanes out of the preview, e.g. one that's broken. Accepts globs like `'origin/claude/*'`, which also cover lanes that appear later |
| `gitweave on <lane...>` / `gitweave on --all` | Put lanes back in |
| `gitweave status [--json]` | Last result: included and excluded lanes, conflicting files, build state, last Anyship deploy |
| `gitweave pause` / `gitweave resume` | Stop/start updating the preview and Anyship deploys while `up` keeps running |

Never edit files in the preview worktree; every update resets it.

## gitweave.json

| Key | Default | Meaning |
| --- | --- | --- |
| `base` | `main`, else `master` | Branch every lane is merged onto |
| `previewPath` | `~/.gitweave/<repo>-<id>/preview` | Where the preview worktree lives (keep it outside the repo's working tree; `~/` is expanded). Set `GITWEAVE_HOME` to move the default root. A preview left in `.git/gitweave/preview` by earlier versions keeps being used |
| `run` | guessed | Long-running app command, run in the preview. Use a watching dev server for live reload |
| `rebuild` | none | Run after each update (compiled stacks). On failure the previous app keeps running; on success the app restarts |
| `install` | guessed | Run when the preview is created or a dependency file changes; the app restarts afterwards |
| `installOn` | lockfiles, `package.json` | File names that trigger `install` |
| `remotePatterns` | `[]` | Remote branches to include as lanes, e.g. `["origin/claude/*"]` (fetched every `fetchIntervalSec`) |
| `order` | `[]` | Lane names merged first, in this order. Then the main worktree, other worktrees, remotes, alphabetically |
| `ignore` | `node_modules`, build dirs | Path segments whose changes don't trigger a merge |
| `copy` | `.env`, `.env.local`, `.dev.vars` | Untracked files copied from the main worktree into the preview |
| `settleMs` / `pollMs` | 1500 / 2000 | Quiet period before merging; how often to check base, worktrees and pause |
| `anyship` | `false` | Deploy the merged preview to Anyship while `up` runs (also `up --anyship`) |
| `anyshipReviewApp` | `integration` | Suffix of the Anyship project the preview deploys to: `<app>-<suffix>` |
| `anyshipDebounceSec` | 30 | Quiet period after the last merge before deploying |

## Anyship

With `anyship` on, `gitweave up` deploys the combined preview to its own Anyship project, so all lanes are visible at one stable URL. Your real Anyship project is never touched.

- The repo must have been deployed to Anyship once (its `.anyship/project.json`, committed or in the main checkout, names the app). Without it gitweave warns once and turns deploys off.
- After `anyshipDebounceSec` with no new merge, the merged commit is exported to a plain folder next to the preview (`<previewPath>-anyship`) and deployed with the installed `anyship deploy`. The first deploy creates `<app>-integration`; that folder keeps the integration project's identity afterwards.
- `.env*`, `.dev.vars*` and key files (`*.pem`, `*.key`, …) are never uploaded; the integration app gets its settings from Anyship's environment configuration.
- One deploy runs at a time, with at most one queued after it; a merge identical to the last deployed one is skipped. The local preview and app restarts never wait on it.
- A failure is logged and recorded, and the next change retries. `gitweave status` and the last line of `gitweave list` show `anyship: <url> @ <sha> (ok|deploying|failed: reason)`.

## How it works

- **Snapshot**: per lane, a private index file (kept under `.git/gitweave/`) is updated from the worktree with `git add --all` and written as a commit whose parent is the worktree's HEAD. It's stored as `refs/gitweave/snap/<lane>`. Ignored files are excluded.
- **Merge**: starting from the base, each lane is merged in order with `git merge-tree --write-tree` (in memory). Conflicting lanes are skipped.
- **Preview**: `git reset --hard <merged>` in the preview worktree rewrites only changed files and leaves ignored folders (`node_modules`, build caches) alone.
- **Triggers**: recursive file watching on each worktree (settled), plus polling for base moves, worktrees added/removed, remote refs and pause.
- **Status**: `.git/gitweave/status.json` (including the last Anyship deploy). Lanes switched off are stored in `.git/gitweave/off.json`, so the choice survives restarts and a running `gitweave up` notices within `pollMs`.

## Not yet

- AI conflict resolution (conflicting lanes are only excluded). Note `git rerere` doesn't apply to in-memory merges.
- Running tests before the preview updates.
- A banner in the page showing which lanes are included.
- Windows: the app's process group isn't killed as a tree.

## Tests

```sh
npm test
```
