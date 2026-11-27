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

`iterbar init` does this for you. By hand, start the server with the project's own copy, so nothing has to be on
`PATH`. With npm (a Vite app, say), in the project root, the folder with its `package.json`:

```bash
npm install --save-dev iterbar     # the project's copy, in node_modules/iterbar
npx --no-install iterbar --help    # finds that copy; fails rather than downloading one if it is missing
```

`npx -y iterbar mcp` then starts the server with that copy (in a folder without one, npx downloads the latest
`iterbar` instead). When the command is on `PATH` (a checkout, above), `iterbar mcp` works the same way. Pass `--root`
with the project's absolute path whenever the agent might start the server from another directory.

Claude Code, also run in the project root. Only for you (local scope: Claude Code keeps the entry in `~/.claude.json`
under the folder you run this in, and loads it only in `claude` sessions started there):

```bash
claude mcp add iterbar -- npx -y iterbar mcp --root "$PWD"
```

To share the server with everyone on the project, use project scope: it writes `.mcp.json` in the folder you run it
in, for you to commit. Leave out `--root`: an absolute path from your machine does not exist on theirs. `iterbar mcp`
then serves the directory Claude Code starts it in, the one you run `claude` from, so start `claude` in the project
root. Claude Code starts a project server only once you approve it (below).

```bash
claude mcp add --scope project iterbar -- npx -y iterbar mcp
```

To see what is registered, run `claude mcp get iterbar` in the project root: it shows the scope (`Local config` or
`Project config (shared via .mcp.json)`), the command and arguments, and a status such as `✔ Connected` or
`⏸ Pending approval`. `claude mcp list` shows every server, and `/mcp` does inside a session.

To launch a known CLI file instead of npx, run it with node: the entry point is `dist/cli.js` in the folder that
`npm ls iterbar --parseable` prints. Give its absolute path for local scope, and `node_modules/iterbar/dist/cli.js`
(relative to the root you start `claude` in) for `.mcp.json`:

```bash
claude mcp add iterbar -- node "$PWD/node_modules/iterbar/dist/cli.js" mcp --root "$PWD"
```

A path like `node_modules/@iterbar/vite/node_modules/@iterbar/cli/dist/cli.js` belongs to older installs, where the
CLI was the `@iterbar/cli` package and npm kept the Vite plugin's copy inside the plugin, so neither npx nor
`node_modules/.bin` found it. The CLI is now the `iterbar` package, which that path never holds; with `iterbar`
installed directly, use `node_modules/iterbar/dist/cli.js`.

### Approving the project server in Claude Code

Servers in local or user scope need no approval. One from the project's `.mcp.json` loads only once approved;
`claude mcp get iterbar` shows ``⏸ Pending approval (run `claude` to approve)`` until then, and
`✘ Rejected (see disabledMcpjsonServers in settings)` after a rejection (`claude mcp reset-project-choices` clears
this project's approvals and rejections).

- **Interactively**: start `claude` in the project root, accept the workspace trust dialog, and approve `iterbar`
  when Claude Code asks about the project's servers. Claude Code saves the choice in `.claude/settings.local.json`.
- **In advance**, approve only `iterbar` (not `enableAllProjectMcpServers`, which approves every server in
  `.mcp.json`) in the project's `.claude/settings.local.json`, your own settings for the project, which git must not
  track:

  ```json
  { "enabledMcpjsonServers": ["iterbar"] }
  ```

  Since Claude Code v2.1.207 this file counts only in a folder you have trusted (accepted the trust dialog in it once);
  earlier versions applied it in any folder. An approval committed to `.claude/settings.json` does not count in an
  untrusted folder: a repository cannot approve its own servers. This file is not MCP "local scope", which is
  `~/.claude.json`.

Headless runs (`claude -p`) differ by version. The current
[Claude Code MCP reference](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust) says
`-p` runs and Agent SDK sessions cannot show the prompt and load project servers without asking (unless
`disabledMcpjsonServers`, `--strict-mcp-config` or `--setting-sources` leaves them out), while `claude mcp get` still
reports `Pending approval`. Some earlier versions left an unapproved project server out of `-p` runs. Approving
`iterbar` first works either way; check the reference for your version.

Approval only lets Claude Code start the server and offer its tools. Each tool call still follows your permission
rules: interactively Claude Code asks, and in a `-p` run, with no one to ask, a call that needs permission is denied.
Allow Iterbar's tools with `--allowedTools "mcp__iterbar__*"` or an `allow` rule `mcp__iterbar__*` in your settings.

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.iterbar]
command = "iterbar"
args = ["mcp", "--root", "/absolute/path/to/project"]
# Long enough for the longest wait_for_feedback you use (at most 1,800 seconds).
tool_timeout_sec = 1900
```

Cursor, in the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "iterbar": { "command": "iterbar", "args": ["mcp", "--root", "${workspaceFolder}"] }
  }
}
```

An agent CLI may end tool calls that take longer than its own timeout. Raise it to cover `wait_for_feedback`'s
timeout, or use a shorter `timeoutSeconds` and wait in a loop.
