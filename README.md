# braid

A live local preview of every git worktree merged together, including uncommitted edits, without merging anything into your branches.

Each worktree is a **lane**. Whenever a file is saved in any lane, braid snapshots that worktree's current files, merges the base branch plus every lane in memory, and updates a dedicated **preview worktree**. Your dev server runs there, so the page shows everyone's in-progress work combined. A lane that conflicts is left out and reported; the rest keep updating.

Source worktrees are never modified: no branch, index, stash or file changes.

Requires Node 20+ and git 2.38+. No dependencies.

## Use

```sh
cd your-repo
node path/to/braid/bin/braid.mjs init   # writes braid.json, creates ../your-repo-braid-preview
node path/to/braid/bin/braid.mjs up     # watch, merge, run the app
```

| Command | What it does |
| --- | --- |
| `braid init` | Writes `braid.json` guessed from the project and creates the preview worktree |
| `braid up [--no-run]` | Watches every worktree, keeps the preview merged, runs and supervises the app |
| `braid merge [--dry-run] [--json]` | One merge, then exit (exit code 1 if any lane was excluded) |
| `braid list [--json]` (or `ls`) | Every lane with its state (`live`, `conflict`, `error`, `off`, `pending`) and source worktree or remote branch |
| `braid off <lane...>` | Take lanes out of the preview, e.g. one that's broken. Accepts globs like `'origin/claude/*'`, which also cover lanes that appear later |
| `braid on <lane...>` / `braid on --all` | Put lanes back in |
| `braid status [--json]` | Last result: included and excluded lanes, conflicting files, build state |
| `braid pause` / `braid resume` | Stop/start updating the preview while `up` keeps running |

Never edit files in the preview worktree; every update resets it.

## braid.json

| Key | Default | Meaning |
| --- | --- | --- |
| `base` | `main`, else `master` | Branch every lane is merged onto |
| `previewPath` | `<repo>-braid-preview` | Where the preview worktree lives (keep it outside the repo) |
| `run` | guessed | Long-running app command, run in the preview. Use a watching dev server for live reload |
| `rebuild` | none | Run after each update (compiled stacks). On failure the previous app keeps running; on success the app restarts |
| `install` | guessed | Run when the preview is created or a dependency file changes; the app restarts afterwards |
| `installOn` | lockfiles, `package.json` | File names that trigger `install` |
| `remotePatterns` | `[]` | Remote branches to include as lanes, e.g. `["origin/claude/*"]` (fetched every `fetchIntervalSec`) |
| `order` | `[]` | Lane names merged first, in this order. Then the main worktree, other worktrees, remotes, alphabetically |
| `ignore` | `node_modules`, build dirs | Path segments whose changes don't trigger a merge |
| `copy` | `.env`, `.env.local`, `.dev.vars` | Untracked files copied from the main worktree into the preview |
| `settleMs` / `pollMs` | 1500 / 2000 | Quiet period before merging; how often to check base, worktrees and pause |

## How it works

- **Snapshot**: per lane, a private index file (kept under `.git/braid/`) is updated from the worktree with `git add --all` and written as a commit whose parent is the worktree's HEAD. It's stored as `refs/braid/snap/<lane>`. Ignored files are excluded.
- **Merge**: starting from the base, each lane is merged in order with `git merge-tree --write-tree` (in memory). Conflicting lanes are skipped.
- **Preview**: `git reset --hard <merged>` in the preview worktree rewrites only changed files and leaves ignored folders (`node_modules`, build caches) alone.
- **Triggers**: recursive file watching on each worktree (settled), plus polling for base moves, worktrees added/removed, remote refs and pause.
- **Status**: `.git/braid/status.json`. Lanes switched off are stored in `.git/braid/off.json`, so the choice survives restarts and a running `braid up` notices within `pollMs`.

## Not yet

- AI conflict resolution (conflicting lanes are only excluded). Note `git rerere` doesn't apply to in-memory merges.
- Running tests before the preview updates.
- A banner in the page showing which lanes are included.
- Windows: the app's process group isn't killed as a tree.

## Tests

```sh
npm test
```
