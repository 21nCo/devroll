# Iterbar agent skills

- `iterbar` teaches a coding agent (Claude Code, Codex, Cursor) the Iterbar feedback loop: create variants of a
  section in a slot, iterate on the comments users leave in the dev bar, and collapse a slot to the chosen variant.
  It uses the tools of `iterbar mcp`; [iterbar/references/setup.md](iterbar/references/setup.md) shows how to put
  the command on `PATH` and register the server.

Users install the skill from the `iterbar` package, which carries it (the build copies `iterbar/` into the
package's `skills/` folder): `npx iterbar init --agent claude` (or `codex`, `cursor`, `all`) copies it into the
agent's skills folder and registers the MCP server. See [iterbar/references/setup.md](iterbar/references/setup.md).

Working on the skill itself, link it from the monorepo root instead, so the installed copy follows the checkout.
For Codex:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/products/iterbar/skills/iterbar" "${CODEX_HOME:-$HOME/.codex}/skills/iterbar"
```

For Claude Code:

```bash
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/products/iterbar/skills/iterbar" "$HOME/.claude/skills/iterbar"
```

For Cursor (which also loads skills from `~/.claude/skills` and the default `~/.codex/skills`, not a custom
`CODEX_HOME`):

```bash
mkdir -p "$HOME/.cursor/skills"
ln -s "$PWD/products/iterbar/skills/iterbar" "$HOME/.cursor/skills/iterbar"
```
