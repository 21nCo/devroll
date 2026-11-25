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

## Known limits

- **A batch with a deleted comment stays incomplete.** `get_batch` counts the comments a batch was sent with; one the
  user deletes from the inbox afterwards is still counted, so `complete` stays `false`. Agents go ahead with the
  comments present once a minute has passed since the newest one, as the skill tells them.
- **`init` checks for links, but not against a link swapped in while it writes.** It refuses to write through a linked
  folder it finds, and checks again right before replacing a file; a folder replaced by a link in the instant between
  that check and the write is not caught. Node has no file APIs that refuse to follow links at every step.

- **Feedback ids follow the wall clock.** The store gives every item an id from the time it was created, strictly
  increasing while the daemon runs and past every stored item when it starts. If the newest item is deleted and the
  daemon restarts after the system clock has gone back past that item's time, a new item can get the deleted item's
  id. An agent still holding that id would then read the new item.
