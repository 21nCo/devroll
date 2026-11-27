# Setting up the Iterbar MCP server

The agent needs two things: a way to start the `iterbar` CLI (the project's own install through npx, or the command
on `PATH`), and its MCP server registered with the agent CLI.
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
needs nothing on `PATH`. Two folders matter below:

- the **npm project root**: the folder with the app's `package.json` and `node_modules` (a Vite app, say);
- the **repository root**: the top of its git repository. Current Claude Code versions key local MCP entries,
  workspace trust and `.claude/settings.local.json` on it. In a one-package repository it is the same folder; in a
  monorepo the app may sit in a subfolder.

With npm, in the npm project root:

```bash
npm install --save-dev iterbar                   # the project's copy, in node_modules/iterbar
node ./node_modules/iterbar/dist/cli.js --help   # checks that copy is there
```

`npx -y iterbar mcp` runs that copy only when it starts in the npm project root after `npm install`. npx finds the
package from the directory it starts in, not from `--root`: started elsewhere, or in a fresh clone before
`npm install`, it can use another copy or download the latest `iterbar`. (`npx --no-install` only stops the
download; it can still use a global or cached copy.) `--root` picks the project only once Iterbar runs. The project's
entry point, `node_modules/iterbar/dist/cli.js`, run with node, always starts that copy (or fails if it is not
installed), so use it whenever the server may start outside the npm project root. When the command is on `PATH` (a
checkout, above), `iterbar mcp` works like npx.

For Claude Code, register the name `iterbar` in one scope: local scope for yourself, or project scope to share it.

**Local scope** (only you). Claude Code keeps the entry in `~/.claude.json` under the project, which current versions
key on the repository root, so the entry also loads in `claude` sessions started in other folders of the repository.
Run this in the npm project root, with absolute paths:

```bash
claude mcp add iterbar -- node "$PWD/node_modules/iterbar/dist/cli.js" mcp --root "$PWD"
```

`claude mcp add iterbar -- npx -y iterbar mcp --root "$PWD"` works too when the npm project root is the repository
root and you start `claude` there; in a monorepo, a session started in another folder would run npx in that folder.

**Project scope** (everyone on the project). `claude mcp add --scope project` writes `.mcp.json` in the folder you run
it in, for you to commit, and Claude Code reads it in sessions started in that folder or below it. Run it, and start
`claude`, in the npm project root. Leave out `--root`: an absolute path from your machine does not exist on theirs.
`iterbar mcp` then serves the directory Claude Code starts it in, and the relative path resolves from there:

```bash
claude mcp add --scope project iterbar -- node node_modules/iterbar/dist/cli.js mcp
```

(`claude mcp add --scope project iterbar -- npx -y iterbar mcp` also works, but in a clone where `npm install` has
not run yet it downloads the latest `iterbar` instead of failing.) Whether Claude Code starts a project server depends
on approval and on how you run it (below).

To see what is registered, run `claude mcp get iterbar` in the folder you start `claude` in. It shows the scope
(`Local config` or `Project config (shared via .mcp.json)`), the command and arguments, and a status such as
`✔ Connected` or `⏸ Pending approval`. `claude mcp list` shows the other servers too (but not a rejected one, below),
and `/mcp` does inside a session. Local scope wins over project scope: with both entries, Claude Code uses your local
one, and `get` shows only it, `✔ Connected` say, while the shared one is still pending or rejected (`list` may add a
warning that `iterbar` is defined in more than one scope). So read a status as the project server's only when `get`
reports `Project config`; to check the shared entry, remove yours with `claude mcp remove --scope local iterbar`. The
shared command and arguments are in `.mcp.json`.

A path like `node_modules/@iterbar/vite/node_modules/@iterbar/cli/dist/cli.js` belongs to older installs, where the
CLI was the `@iterbar/cli` package and npm kept the Vite plugin's copy inside the plugin, so neither npx nor
`node_modules/.bin` found it. The CLI is now the `iterbar` package, which that path never holds; with `iterbar`
installed directly, use `node_modules/iterbar/dist/cli.js`.

### Approving the project server in Claude Code

Servers in local or user scope need no approval. A server from the project's `.mcp.json` does, in interactive
sessions: `claude` asks before starting it, and `claude mcp get iterbar` (with `Project config` as its scope) shows
``⏸ Pending approval (run `claude` to approve)`` until you approve it. Headless runs can differ (below), so a pending
status does not mean a `claude -p` run leaves the server out.

- **Interactively**: start `claude` in the npm project root, accept the workspace trust dialog, and approve `iterbar`
  when Claude Code asks about the project's servers. Claude Code saves the choice in `.claude/settings.local.json`;
  in a git repository, current versions (v2.1.211 and later) usually keep that file at the repository root and apply
  it across the repository, where earlier ones kept it in the folder you started in (exceptions:
  [where Claude Code keeps the local file](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)).
- **In advance**, approve only `iterbar` (not `enableAllProjectMcpServers`, which approves every server in
  `.mcp.json`) in that `.claude/settings.local.json`, your own settings for the project, which git must not track:

  ```json
  { "enabledMcpjsonServers": ["iterbar"] }
  ```

  Since Claude Code v2.1.207 this file counts only once you have trusted the folder (accepted the trust dialog there
  once); earlier versions applied it in any folder. An approval committed to `.claude/settings.json` does not count in
  an untrusted folder: a repository cannot approve its own servers. This file is not MCP "local scope", which is
  `~/.claude.json`.

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

Codex, in `~/.codex/config.toml`. Codex starts the server from any folder, so name the project's entry point by its
absolute path (or use `command = "iterbar"` with `args = ["mcp", "--root", ...]` when the command is on `PATH`):

```toml
[mcp_servers.iterbar]
command = "node"
args = ["/absolute/path/to/project/node_modules/iterbar/dist/cli.js", "mcp", "--root", "/absolute/path/to/project"]
# Long enough for the longest wait_for_feedback you use (at most 1,800 seconds).
tool_timeout_sec = 1900
```

Cursor, in the project's `.cursor/mcp.json` (the entry `iterbar init` writes when the project has `iterbar`
installed; `"command": "iterbar"` with `"args": ["mcp", "--root", "${workspaceFolder}"]` also works when the command
is on `PATH`):

```json
{
  "mcpServers": {
    "iterbar": { "command": "npx", "args": ["-y", "iterbar", "mcp", "--root", "${workspaceFolder}"] }
  }
}
```


An agent CLI may end tool calls that take longer than its own timeout. Raise it to cover `wait_for_feedback`'s
timeout, or use a shorter `timeoutSeconds` and wait in a loop.
