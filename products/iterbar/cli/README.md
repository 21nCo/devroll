# @iterbar/cli

The Iterbar command line: the local daemon that stores the feedback left in the Iterbar dev bar, the MCP server
that lets a coding agent read and answer it, and `iterbar init`, which sets a project up for an agent. The package
also carries the `iterbar` agent skill.

```bash
iterbar init --agent claude   # or codex, cursor, all: installs the skill and registers the MCP server
iterbar mcp                   # the MCP server (what init registers)
iterbar dev                   # the daemon, when no Iterbar dev-server plugin starts it
```

The package is not on npm yet: run it as `node <path to dist/cli.js>` from the copy the project has (the bar's Help
sheet shows that command) or link `iterbar` from a Devroll checkout (see the skill's `references/setup.md`).

Run `iterbar <command> --help` for each command's options. The Vite plugin (`@iterbar/vite`) starts the daemon
with the dev server and shows the bar; see the skill's `references/setup.md` for the full setup.

## Known limits

- **Feedback ids follow the wall clock.** The store gives every item an id from the time it was created, strictly
  increasing while the daemon runs and past every stored item when it starts. If the newest item is deleted and the
  daemon restarts after the system clock has gone back past that item's time, a new item can get the deleted item's
  id. An agent still holding that id would then read the new item.
