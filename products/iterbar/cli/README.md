# iterbar

The Iterbar command line: the local daemon that stores the feedback left in the Iterbar dev bar, the MCP server
that lets a coding agent read and answer it, and `iterbar init`, which sets a project up for an agent. The package
also carries the `iterbar` agent skill.

```bash
npx iterbar init --agent claude   # or codex, cursor, all: installs the skill and registers the MCP server
npx iterbar mcp                   # the MCP server (what init registers, as "npx -y iterbar mcp")
npx iterbar dev                   # the daemon, when no Iterbar dev-server plugin starts it
```

Run `iterbar <command> --help` for each command's options. The Vite plugin (`@iterbar/vite`) starts the daemon
with the dev server and shows the bar; see the skill's `references/setup.md` for the full setup.
