# gitweave

A live local preview of every git worktree merged together, including uncommitted edits, without merging anything into your branches.

Each worktree is a **lane**. Whenever a file is saved in any lane, gitweave snapshots that worktree's current files, merges the base branch plus every lane in memory, and updates a dedicated **preview worktree**. Your dev server runs there, so the page shows everyone's in-progress work combined. A lane that conflicts is left out and reported; the rest keep updating.

Source worktrees are never modified: no branch, index, stash or file changes.

Requires Node 20+ and git 2.38+. No dependencies.

## Use

```sh
cd your-repo
node path/to/gitweave/bin/gitweave.mjs init   # writes gitweave.json, creates the preview worktree in ~/.gitweave/<repo>-<id>/preview
node path/to/gitweave/bin/gitweave.mjs up     # start in the background: watch, merge, run the app
```

| Command | What it does |
| --- | --- |
| `gitweave init` | Writes `gitweave.json` guessed from the project and creates the preview worktree |
| `gitweave up [--no-run] [--anyship] [--foreground]` | Starts in the background (one per repo) and prints the first result and URL: watches every worktree, keeps the preview merged, runs and supervises the app, resolves conflicts. `--anyship` also deploys it (see below); `--foreground` keeps it in the terminal |
| `gitweave down` | Stops the background gitweave |
| `gitweave logs [-f]` | Shows (or follows) its log, `.git/gitweave/up.log` |
| `gitweave merge [--dry-run] [--json]` | One merge, then exit (exit code 1 if any lane was excluded) |
| `gitweave add <branch...>` / `gitweave add --all` | Include remote branches as lanes: `feature-x` (on origin), `origin/feature-x`, or globs like `'origin/claude/*'`. `--all` includes every remote branch. Globs cover branches pushed later; they appear within `fetchIntervalSec` |
| `gitweave remove <branch...>` / `gitweave remove --all` | Stop including remote branches added with `add` |
| `gitweave off <lane...>` | Take lanes out of the preview, e.g. one that's broken. Accepts globs like `'origin/claude/*'`, which also cover lanes that appear later |
| `gitweave on <lane...>` / `gitweave on --all` | Put lanes back in |
| `gitweave status [--json]` | Whether it's running; what it watches (worktrees, PRs, remote patterns, lanes turned off); every source lane with its state (`live`, `resolving`, `conflict`, `error`, `off`, `stale`, `pending`) and where it comes from; and the outputs (preview commit and folder, local URL, last Anyship deploy) |
| `gitweave pause` / `gitweave resume` | Stop/start updating the preview and Anyship deploys while `up` keeps running |

Never edit files in the preview worktree; every update resets it.

## gitweave.json

| Key | Default | Meaning |
| --- | --- | --- |
| `base` | `main`, else `master` | Branch every lane is merged onto |
| `previewPath` | `~/.gitweave/<repo>-<id>/preview` | Where the preview worktree lives (keep it outside the repo's working tree; `~/` is expanded). Set `GITWEAVE_HOME` to move the default root. A preview left in `.git/gitweave/preview` by earlier versions keeps being used |
| `run` | guessed | Long-running app command, run in the preview. Use a watching dev server for live reload |
| `rebuild` | none | Run on the first pass and after each update (compiled stacks). On failure the previous app keeps running; on success the app restarts |
| `install` | guessed | Run when the preview is created or a dependency file changes; the app restarts afterwards |
| `installOn` | lockfiles, `package.json` | File names that trigger `install` |
| `remotePatterns` | `[]` | Remote branches always included as lanes, on top of those added with `gitweave add` (fetched every `fetchIntervalSec`). Branches already merged into the base are skipped |
| `staleDays` | 30 | Remote branches with no commits in this many days are skipped and shown as `stale` in `list` (`0` includes them all) |
| `resolve` | `true` | Resolve conflicting lanes automatically (see below) |
| `resolveCommand` | `claude -p …` | Command that resolves the conflicts; it runs in a private worktree with `$GITWEAVE_PROMPT`, `$GITWEAVE_FILES` and `$GITWEAVE_LANE` set |
| `order` | `[]` | Lane names merged first, in this order. Then the main worktree, other worktrees, remotes, alphabetically |
| `ignore` | `node_modules`, build dirs | Path segments whose changes don't trigger a merge |
| `copy` | `.env`, `.env.local`, `.dev.vars`, `pnpm-workspace.yaml`, `.npmrc` | Files copied from the main worktree into the preview when git doesn't track them (e.g. pnpm build approvals kept in an uncommitted `pnpm-workspace.yaml`) |
| `settleMs` / `pollMs` | 1500 / 2000 | Quiet period before merging; how often to check base, worktrees and pause |
| `portless` | `true` | Serve the app at a stable, per-project URL through [portless](https://github.com/vercel-labs/portless) when it's installed: `<repo>.gitweave` (e.g. `https://dcmodel.gitweave.localhost`), or a string to pick the name. Without portless (or with `false`), gitweave reports the local URL the dev server prints |
| `prs` | `true` | Include open, non-draft GitHub pull requests as lanes (`pr/<n>`), fetched every `fetchIntervalSec` through `gh`. A PR whose branch is checked out in a worktree stays a worktree lane |
| `anyship` | `false` | Deploy the merged preview to Anyship while `up` runs (also `up --anyship`) |
| `anyshipReviewApp` | `integration` | Suffix of the Anyship project the preview deploys to: `<app>-<suffix>` |
| `anyshipDebounceSec` | 30 | Quiet period after the last merge before deploying |

## Running the whole app

The preview should run everything a deploy would, not just the frontend's dev server. `gitweave init` suggests that where it can: for a Cloudflare Workers project (a `wrangler` config) it builds with `<pm> run build` and runs `wrangler dev` on the preview's port, so the API, bindings and local D1 come up alongside the built frontend. For other stacks, point `run` at a command that starts the full server.

## Conflict resolution

When a lane conflicts with the lanes before it, gitweave leaves it out for the moment (`resolving` in `list`) and resolves it in the background:

- The lane is merged for real in a private worktree next to the preview (`<previewPath>-resolve`), and `resolveCommand` (by default the Claude Code CLI, `claude -p`, allowed only to read and edit files) fixes the conflict markers, keeping both sides' intent.
- The resolved files are cached under `.git/gitweave/resolutions/`, keyed by exactly what collided (each conflicted file's base, ours and theirs). The next merge applies them in memory and the lane goes `live`, with the resolved files listed. Edits elsewhere reuse the cache; a new collision in those files is resolved again.
- One resolution runs at a time. If it fails or leaves markers, the lane stays out with the reason in `list`, and isn't retried until the conflict changes (or gitweave restarts).
- Source worktrees and branches are never touched; the resolution exists only in the preview. Set `"resolve": false` to only report conflicts.

## Anyship

With `anyship` on, `gitweave up` deploys the combined preview to its own Anyship project, so all lanes are visible at one stable URL. Your real Anyship project is never touched.

- The repo must have been deployed to Anyship once (its `.anyship/project.json`, committed or in the main checkout, names the app). Without it gitweave warns once and turns deploys off.
- After `anyshipDebounceSec` with no new merge, the merged commit is exported to a plain folder next to the preview (`<previewPath>-anyship`) and deployed with the installed `anyship deploy`. The first deploy creates `<app>-integration`; that folder keeps the integration project's identity afterwards.
- `.env*`, `.dev.vars*` and key files (`*.pem`, `*.key`, …) are never uploaded; the integration app gets its settings from Anyship's environment configuration.
- One deploy runs at a time, with at most one queued after it; a merge identical to the last deployed one is skipped. The local preview and app restarts never wait on it.
- A failure is logged and recorded, and the next change retries. `gitweave status` shows `anyship: <url> @ <sha> (ok|deploying|failed: reason)`.

## How it works

- **Snapshot**: per lane, a private index file (kept under `.git/gitweave/`) is updated from the worktree with `git add --all` and written as a commit whose parent is the worktree's HEAD. It's stored as `refs/gitweave/snap/<lane>`. Ignored files are excluded.
- **Merge**: starting from the base, each lane is merged in order with `git merge-tree --write-tree` (in memory). Conflicting lanes are skipped.
- **Preview**: `git reset --hard <merged>` in the preview worktree rewrites only changed files and leaves ignored folders (`node_modules`, build caches) alone.
- **Triggers**: recursive file watching on each worktree (settled), plus polling for base moves, worktrees added/removed, remote refs and pause.
- **Status**: `.git/gitweave/status.json` (including the last Anyship deploy). Lanes switched off are stored in `.git/gitweave/off.json` and branches added with `add` in `.git/gitweave/remotes.json`, so the choice survives restarts and a running `gitweave up` notices within `pollMs`.

## Not yet

- Running tests before the preview updates.
- A banner in the page showing which lanes are included.
- Windows: the app's process group isn't killed as a tree.

## Tests

```sh
npm test
```
