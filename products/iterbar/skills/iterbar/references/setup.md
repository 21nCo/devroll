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
[ -f "$cli" ] || cli="$(npm root)/iterbar/dist/cli.js"  # else the hoisted one (npm root prints where)
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
point resolves and `iterbar mcp` serves that folder unless `--root` names another one. (Started in a subfolder, the
relative paths miss and `claude mcp get iterbar` reports `✘ Failed to connect`.)

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

To see what is registered, run `claude mcp get iterbar` in the folder you start `claude` in. It shows the scope
(`Local config`, `User config` or `Project config (shared via .mcp.json)`), the command and arguments, and a status
such as `✔ Connected` or `⏸ Pending approval`. `claude mcp list` shows the other servers too (but not a rejected one,
below), and `/mcp` does inside a session. To show `✔ Connected`, `get` and `list` start the command of every entry
that needs no approval or is approved, so read a shared command you have not seen in `.mcp.json` first (below).

An `iterbar` entry of your own can take the shared one's place: a local entry always wins over project scope, and a
user entry wins while the shared one is not approved. Claude Code then uses yours, and `get` shows only it,
`✔ Connected` say, while the shared one is still pending or rejected (`list` may add a warning that `iterbar` is
defined in more than one scope). So read a status as the project server's only when `get` reports `Project config`.
To check the shared entry, set yours aside and restore it unchanged afterwards. Claude Code keeps both kinds in
`~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set), a local entry under the repository root:

```bash
cfg="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
saved="$(node -p 'JSON.stringify(require(process.argv[1]).projects[process.argv[2]].mcpServers.iterbar)' \
  "$cfg" "$(git rev-parse --show-toplevel)")"
claude mcp remove --scope local iterbar
claude mcp get iterbar                             # the shared entry now (or a user entry, as above)
claude mcp add-json --scope local iterbar "$saved"  # yours again, arguments and environment included
```

A user entry is yours in every project: save it with
`node -p 'JSON.stringify(require(process.argv[1]).mcpServers.iterbar)' "$cfg"`, and remove and restore it with
`--scope user`.

A path like `node_modules/@iterbar/vite/node_modules/@iterbar/cli/dist/cli.js` belongs to older installs, where the
CLI was the `@iterbar/cli` package and npm kept the Vite plugin's copy inside the plugin, so neither npx nor
`node_modules/.bin` found it. The CLI is now the `iterbar` package, which that path never holds; with `iterbar`
installed directly, use `node_modules/iterbar/dist/cli.js`.

### Approving the project server in Claude Code

Servers in local or user scope need no approval. A server from the project's `.mcp.json` does, in interactive
sessions: `claude` asks before starting it, and `claude mcp get iterbar` (with `Project config` as its scope) shows
``⏸ Pending approval (run `claude` to approve)`` until you approve it. Headless runs can differ (below), so a pending
status does not mean a `claude -p` run leaves the server out.

- **Interactively**: start `claude` in the npm project root and accept the workspace trust dialog. Claude Code then
  asks about the project's servers you have not answered for, and saves an answer for every server it lists in
  `.claude/settings.local.json`; in a git repository, current versions (v2.1.211 and later) usually keep that file at
  the repository root and apply it across the repository, where earlier ones kept it in the folder you started in
  (exceptions:
  [where Claude Code keeps the local file](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)).
  An approved server goes in `enabledMcpjsonServers`; a declined one goes in `disabledMcpjsonServers`, a rejection
  (below) that also keeps it out of `claude -p` runs. When only `iterbar` is new, `Use this MCP server` approves
  just it, while `Use this and all future MCP servers in this project` also sets `enableAllProjectMcpServers`, which
  approves every server the project's `.mcp.json` lists, now or later. When several servers are new, current
  versions list them (`<n> new MCP servers found in this project`) and reject every one you leave unselected, and
  cancelling the dialog rejects them all, `iterbar` included. So select every server you want, not only `iterbar`;
  to approve `iterbar` without answering for the others, approve it in advance.
- **In advance**, approve only `iterbar` (not `enableAllProjectMcpServers`, which approves every server in
  `.mcp.json`) in that `.claude/settings.local.json`, your own settings for the project, which git must not track. Add
  `"iterbar"` to its `enabledMcpjsonServers` list and keep the file's other settings and the list's other entries; a
  new file holds just:

  ```json
  { "enabledMcpjsonServers": ["iterbar"] }
  ```

  Since Claude Code v2.1.207 this file counts only once you have trusted the folder (accepted the trust dialog there
  once); earlier versions applied it in any folder. An approval committed to `.claude/settings.json` does not count in
  an untrusted folder: a repository cannot approve its own servers. This file is not MCP "local scope", which is
  `~/.claude.json`.

An approval, either way, is for the name `iterbar`, not for one command or one file: it covers an `iterbar` entry
in every `.mcp.json` the settings file applies to (with the file at the repository root, every `.mcp.json` in the
repository), and it stays when someone changes that entry's command. So after pulling, read what changed in the
`.mcp.json` files themselves, for example with `git diff ORIG_HEAD HEAD -- '*.mcp.json'` right after `git pull`,
before you start `claude` or run `claude mcp get` or `claude mcp list`: each of those starts an approved server's
command. When entries need separate decisions, such as one for each app in a monorepo, give each its own name
(`claude mcp add --scope project iterbar-web -- ...`), and use that name in `enabledMcpjsonServers` and in tool
rules (`mcp__iterbar-web`).

A rejection wins over any approval. Rejecting `iterbar` in the dialog adds it to `disabledMcpjsonServers` in
`.claude/settings.local.json`, and the same entry in any other settings file Claude Code reads (the project's
committed `.claude/settings.json`, your `~/.claude/settings.json`, or your organization's managed settings) rejects
it too. While one does, `enabledMcpjsonServers` does nothing and `claude mcp get iterbar` shows
`✘ Rejected (see disabledMcpjsonServers in settings)` (`claude mcp list` leaves a rejected server out). To undo it,
find each settings file whose `disabledMcpjsonServers` lists `"iterbar"`, remove only that entry and keep the rest,
then check with `claude mcp get iterbar`; ask your administrator about managed settings.
`claude mcp reset-project-choices` is not a targeted undo: it clears the approvals and rejections stored for the
project for every server, `.claude/settings.local.json` included, and leaves a rejection in any other settings file in
place (it names the servers that stay rejected).

Headless runs (`claude -p`) differ by version. The current
[Claude Code MCP reference](https://code.claude.com/docs/en/mcp#project-scope) says `-p` runs and Agent SDK sessions
cannot show the prompt, so by default they load project servers without asking, while `claude mcp get` still reports
`Pending approval`. Other settings can still keep the server out: a `disabledMcpjsonServers` entry,
`--strict-mcp-config`, `--setting-sources` that leaves out project settings, turning the server off for the project in
`/mcp` (`⊘ Disabled for this project`), or an organization MCP policy (see also
[approvals and workspace trust](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust)).
Some earlier versions left an unapproved project server out of `-p` runs. Approving `iterbar` first works on either
kind of version; check the reference for yours.

Approval only lets Claude Code start the server and offer its tools. Each tool call still follows your permission
rules: interactively Claude Code asks, and in a `-p` run, with no one to ask, a call that needs permission is denied.
Allow Iterbar's tools with `--allowedTools "mcp__iterbar__*"` or an `allow` rule in your settings: `mcp__iterbar__*`,
or the server-level `mcp__iterbar`, which also covers every tool of the server.

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
