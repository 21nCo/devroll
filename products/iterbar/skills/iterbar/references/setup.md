# Setting up the Iterbar MCP server

The agent needs two things: a way to start the `iterbar` CLI (the project's own install, through npx or by running
its entry point `iterbar/dist/cli.js` with node, or the command on `PATH`), and its MCP server registered with the
agent CLI.
These steps are for the user (or for you, when the user asks you to set it up).

## The quick way: `iterbar init`

The `iterbar` package carries the `iterbar` command, the MCP server and this skill. In the project's root:

```bash
npx iterbar init --agent claude     # or codex, cursor, all
```

It copies this skill into the agent's skills folder (`--scope project` puts it in the project instead), registers the
MCP server (Claude Code: `.mcp.json`; Cursor: `.cursor/mcp.json`; for Codex it prints the `config.toml` lines to add),
and prints the prompt to paste. It never replaces an existing iterbar skill or server entry that differs unless you
pass `--force` (an entry an earlier init wrote is its own, and is updated), and `--dry-run` shows what it would
change.

The MCP entry it writes depends on where the CLI comes from, so the agent can always start the server:

- The project has `iterbar` installed directly (`npm i -D iterbar`), so its `iterbar` command is the project's:
  `npx -y iterbar mcp`, which runs that copy.
- Otherwise, run through `npx iterbar init`: `npx -y iterbar@<version> mcp`, pinned to the version init ran, so
  npx fetches that CLI. (The Vite plugin depends on `iterbar`, but with pnpm a dependency's dependency is not a
  project command, so npx would not find the plugin's copy; npm usually places it in `node_modules/iterbar`.
  Install `iterbar` directly either way, so the project has one copy at a known place.)
- Run from a Devroll checkout (below), or from a tarball npx installed: `node <path to cli.js> mcp`.

## From a Devroll checkout (contributors)

To run the command from a checkout instead of the package:

```bash
pnpm install
pnpm --filter iterbar... build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/products/iterbar/cli/dist/cli.js" "$HOME/.local/bin/iterbar"
iterbar --help
```

If `iterbar --help` reports that the command is not found, `$HOME/.local/bin` is not on `PATH`: add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile (`~/.zshrc` or `~/.bashrc`) and open a new shell. An
agent CLI started some other way may not read that profile; then register the server with the symlink's absolute
path (`$HOME/.local/bin/iterbar`, expanded) as its command instead of `iterbar`. `iterbar init` from a checkout
installs the checkout's copy of this skill.

`iterbar dev --root <project>` runs the daemon for a project; `iterbar mcp --root <project>` runs the MCP server
for the same project. Both default to the current directory. The MCP server starts even when no daemon runs; its
tools report `daemon_unavailable` until one does.

## Registering the server by hand

`iterbar init` does this for you. By hand, start the server with the project's own copy of the CLI, so the agent
needs nothing on `PATH`. Every form below settles three things:

- **Which copy of the CLI runs**: the one the app itself resolves. The **npm project root** is the folder with the
  app's `package.json` (a Vite app, say), where you run `npm install`. In a standalone app npm puts `iterbar` in that
  folder's `node_modules`. In an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) repository it
  usually hoists it to the workspace root's `node_modules`, and keeps a copy in the app's own `node_modules` only when
  another workspace needs a different version; the app then uses its own copy, so pick that one first.
- **Which project the server serves**: `iterbar mcp --root <folder>` (default: the folder it starts in) talks to
  the daemon that `<folder>/.iterbar/daemon.json` names, so `<folder>` must be the Iterbar Vite plugin's project
  root. That is the folder the plugin's `projectRoot` option names (relative to Vite's root), or else Vite's root,
  which is, in order: a folder the dev script names (`vite <dir>`), the config's `root` (a relative one is relative
  to the folder Vite starts in, the npm project root for `npm run dev`), or the folder Vite starts in. Where the
  config file sits does not count: `vite --config config/vite.config.ts` keeps the folder Vite starts in. A folder
  with no running daemon makes every tool report `daemon_unavailable`; a folder of another project that runs
  Iterbar connects to that project's daemon, whose feedback the tools then read and change. So confirm the root
  (below) before you use the tools.
- **Where the agent starts the server**: for a shared `.mcp.json`, the folder you start the agent in, so its paths
  are relative to that folder; an entry with absolute paths works from any folder. Current Claude Code versions key
  local MCP entries, workspace trust and `.claude/settings.local.json` on the **repository root** (the top of the git
  repository), which in a monorepo is above the app folder.

With npm, in the npm project root:

```bash
npm install --save-dev iterbar                          # the project's copy
cli="$PWD/node_modules/iterbar/dist/cli.js"             # the app's own copy, if npm put one there,
[ -d "$PWD/node_modules/iterbar" ] ||                  # else the hoisted one (npm root prints where)
  cli="$(npm root)/iterbar/dist/cli.js"
node "$cli" --help                                      # checks that copy is there
root="$PWD"                                             # the Vite plugin's project root (below)
```

`root="$PWD"` is right in the usual case: the dev script runs `vite` with no folder in the npm project root, and
the config sets neither `root` nor the plugin's `projectRoot`. When the config sets `root: "src"`, use
`root="$PWD/src"`; when the dev script is `vite site`, use `root="$PWD/site"`; when the plugin sets `projectRoot`,
use the folder that names. (Or set `projectRoot` to the npm project root, `projectRoot: ".."` with `root: "src"`,
and keep `root="$PWD"`.)

To confirm it, run the dev server and open the app in a browser. The dev server logs
`Iterbar daemon: http://127.0.0.1:<port>`, and while it runs this prints that same port and your root (with
symlinks resolved, such as `/private/tmp/...` for `/tmp/...` on macOS):

```bash
grep -E '"(projectRoot|port)"' "$root/.iterbar/daemon.json"   # the file also holds a token: print only these
```

No such file means `root` names no running project; another port means another dev server's project. Fix `root`
before you register the server.

`npx -y iterbar mcp` runs the app's copy only when it starts in the npm project root after `npm install`. npx finds
the package from the directory it starts in, not from `--root`: started elsewhere, or in a fresh clone before
`npm install`, it can use another copy or download the latest `iterbar`. (`npx --no-install` only stops the download;
it can still use a global or cached copy.) `--root` picks the project only once Iterbar runs. The entry point run
with node always starts the copy you picked (or fails if it is not installed), so use it whenever the server may
start outside the npm project root. When the command is on `PATH` (a checkout, above), `iterbar mcp` works like npx.

For Claude Code, register the name `iterbar` in one scope: local scope for yourself, or project scope to share it.

**Local scope** (only you). Claude Code keeps the entry in `~/.claude.json` under the project, which current versions
key on the repository root, so the entry also loads in `claude` sessions started in other folders of the repository.
With `cli` and `root` set as above, both paths are absolute and work from any of them:

```bash
claude mcp add iterbar -- node "$cli" mcp --root "$root"
```

**Project scope** (everyone on the project). `claude mcp add --scope project` writes `.mcp.json` in the folder you run
it in, for you to commit, and Claude Code reads it in sessions started in that folder or below it. Run it, and start
`claude`, in the npm project root, and give both paths relative to that folder: absolute paths from your machine do
not exist on theirs. Claude Code starts the server in the folder you started `claude` in, where the relative entry
point resolves and `iterbar mcp` serves that folder unless `--root` names another one. So start `claude` in the
folder that holds `.mcp.json`: in a folder below it the relative paths resolve from there, which can fail or start
another installed copy that serves that folder, including another Iterbar project's daemon.

```bash
rel="$(node -p 'path.relative(fs.realpathSync("."), fs.realpathSync(process.argv[1]))' "$cli")"
echo "$rel"   # node_modules/iterbar/dist/cli.js, or ../../node_modules/iterbar/dist/cli.js hoisted from apps/web
claude mcp add --scope project iterbar -- node "$rel" mcp
```

In a standalone app that registers `node node_modules/iterbar/dist/cli.js mcp`. When the Vite plugin's project root
is not the npm project root, add it as a relative `--root`, such as `... mcp --root src` for `root: "src"`.
(`claude mcp add --scope project iterbar -- npx -y iterbar mcp` also works in the npm project root, but in a clone
where `npm install` has not run yet it downloads the latest `iterbar` instead of failing.) Whether Claude Code starts
a project server depends on approval and on how you run it (below).

A path like `node_modules/@iterbar/vite/node_modules/@iterbar/cli/dist/cli.js` belongs to older installs, where the
CLI was the `@iterbar/cli` package and npm kept the Vite plugin's copy inside the plugin, so neither npx nor
`node_modules/.bin` found it. The CLI is now the `iterbar` package, which that path never holds; with `iterbar`
installed directly, use `node_modules/iterbar/dist/cli.js`.

### Checking and approving the project server in Claude Code

Read a shared command before anything starts it. The project server is the `iterbar` entry in `.mcp.json`, in the
folder you start `claude` in or a folder above it up to the repository root. After a pull, this lists what changed in
every `.mcp.json` of the repository, from any folder in it:

```bash
git diff ORIG_HEAD HEAD -- ':/*.mcp.json'
```

Then `claude mcp get iterbar`, in the folder you start `claude` in, shows the scope (`Local config`, `User config` or
`Project config (shared via .mcp.json)`), the command and arguments, and a status such as `✔ Connected`,
``⏸ Pending approval (run `claude` to approve)`` or `✘ Rejected`. `claude mcp list` shows the other servers too, and
`/mcp` does inside a session. To report `✔ Connected`, `get` starts the `iterbar` entry it shows if that entry is
approved or needs no approval; `list` and `/mcp` start every such server in every scope. So before running them, read
every server in the `.mcp.json` files that apply, not only `iterbar`.

Register the name `iterbar` in one scope only. A same-named local entry takes the shared one's place, and so does a
user entry while the shared one is not approved; `get` then shows that entry. So read a status as the project
server's only when `get` reports `Project config`. For a personal entry next to a shared one, use another name
(`claude mcp add iterbar-dev -- ...`).

Servers in local or user scope need no approval; one from `.mcp.json` does, and approval only decides whether Claude
Code starts it. The [Claude Code MCP reference](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust)
covers the details for your version.

- **Interactively**: start `claude` in the npm project root and accept the workspace trust dialog. Claude Code then
  asks about the project's new servers and saves an answer for each server it lists in `.claude/settings.local.json`
  (your own settings, which git must not track;
  [where Claude Code keeps it](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)):
  approved ones in `enabledMcpjsonServers`, the others in `disabledMcpjsonServers`. A server you leave unselected is
  rejected, and cancelling rejects them all, so select every server you want. `Use this and all future MCP servers in
  this project` approves everything `.mcp.json` lists, now or later; `Use this MCP server` approves just `iterbar`.
- **In advance**: add `"iterbar"` to `enabledMcpjsonServers` in that file, keeping its other settings and the list's
  other entries; a new file holds just `{ "enabledMcpjsonServers": ["iterbar"] }`. Since Claude Code v2.1.207 it
  counts only in a folder you have trusted.

An approval is for the name `iterbar`, not for one command or one file: it covers an `iterbar` entry in every
`.mcp.json` the settings file applies to, and it stays when someone changes the command, so keep reading `.mcp.json`
changes after a pull. When entries need separate decisions, such as one per app in a monorepo, give each its own name
(`iterbar-web`) and use that name in `enabledMcpjsonServers` and in tool rules (`mcp__iterbar-web`).

`"iterbar"` in `disabledMcpjsonServers` in any settings file Claude Code reads (`.claude/settings.local.json`, the
committed `.claude/settings.json`, `~/.claude/settings.json` or managed settings) wins over any approval: `get` shows
`✘ Rejected` and `list` leaves the server out. To undo it, remove only that entry from the file that has it.

Headless runs differ by version. The current [reference](https://code.claude.com/docs/en/mcp#project-scope) says
`claude -p` runs and Agent SDK sessions cannot show the prompt, so by default they load project servers without
asking, while `get` still reports `Pending approval`; a rejection or options such as `--strict-mcp-config` can still
keep the server out. Some earlier versions left an unapproved project server out of `-p` runs, so approving `iterbar`
in advance works on either kind.

Approval does not allow tool calls, which still follow your permission rules: interactively Claude Code asks, and in a
`-p` run a call that needs permission is denied. Allow Iterbar's tools with `--allowedTools "mcp__iterbar__*"` or an
`allow` rule in your settings (`mcp__iterbar__*`, or `mcp__iterbar` for every tool of the server).

Codex, in `~/.codex/config.toml`. Codex starts the server from any folder, so give both paths absolute: the `$cli`
and `$root` from above (`echo "$cli" "$root"`). Use `command = "iterbar"` with `args = ["mcp", "--root", ...]`
instead when the command is on `PATH`.

```toml
[mcp_servers.iterbar]
command = "node"
args = ["/absolute/path/to/node_modules/iterbar/dist/cli.js", "mcp", "--root", "/absolute/path/to/vite/project/root"]
# Long enough for the longest wait_for_feedback you use (at most 1,800 seconds).
tool_timeout_sec = 1900
```

Cursor, in the project's `.cursor/mcp.json`. `${workspaceFolder}` is the folder open in Cursor. When that folder
is both the npm project root and the Vite plugin's project root, use the entry `iterbar init` writes when the project
has `iterbar` installed (`"command": "iterbar"` with `"args": ["mcp", "--root", "${workspaceFolder}"]` also works
when the command is on `PATH`):

```json
{
  "mcpServers": {
    "iterbar": { "command": "npx", "args": ["-y", "iterbar", "mcp", "--root", "${workspaceFolder}"] }
  }
}
```

Otherwise name both from `${workspaceFolder}` with the node entry point. For a repository opened at its root, with
the app in `apps/web` (also the Vite plugin's project root) and `iterbar` hoisted to the root's `node_modules`:

```json
{
  "mcpServers": {
    "iterbar": {
      "command": "node",
      "args": ["${workspaceFolder}/node_modules/iterbar/dist/cli.js", "mcp", "--root", "${workspaceFolder}/apps/web"]
    }
  }
}
```


An agent CLI may end tool calls that take longer than its own timeout. Raise it to cover `wait_for_feedback`'s
timeout, or use a shorter `timeoutSeconds` and wait in a loop.
