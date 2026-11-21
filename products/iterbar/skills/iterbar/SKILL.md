---
name: iterbar
description: Iterate on a web UI with the user through Iterbar, a dev bar that collects comments on page elements and choices between variants. Use when a user asks for several versions of a component or section to compare, to work through or wait for Iterbar feedback, to answer comments left in the dev bar, or to keep a chosen variant and remove the others.
---

# Iterbar

Iterbar lets the user look at a running dev page, switch between versions of a section, point at an element and leave
a comment, or pick a winning version. You read that feedback, change the code, and answer in the same thread; the
user sees your replies and statuses live in the bar.

You reach Iterbar only through the `iterbar` MCP server's tools. Never read or write `.iterbar/` yourself, except to
open an attachment file whose `path` a tool gave you.

## Prerequisites

1. The `iterbar` MCP tools are available (`list_feedback`, `get_feedback`, `get_batch`, `reply`, `set_status`,
   `list_slots`, `wait_for_feedback`). If they are not, stop and ask the user to add the server; see
   [references/setup.md](references/setup.md).
2. The daemon runs. Call `list_feedback`. If it fails with error code `daemon_unavailable`, ask the user to run
   `iterbar dev` in the project root (or the app's dev server, when its Iterbar plugin starts the daemon), then
   retry. Do not try to start long-running processes yourself unless the user asks you to.

Read [references/tools.md](references/tools.md) for every tool's inputs, results and errors.

## Create N variants in a slot

A slot is one place in the UI that renders one of several named versions. Only the active version renders; the bar
switches between them in place, and the `iterbar` URL parameter (`?iterbar=pricing:v2`) selects one for a link.

1. Pick a slot name for the section (for example `pricing` or `hero`). Slot and version names are 1 to 64 letters,
   digits, `_`, `.` or `-`, starting with a letter or digit; they must not contain `:` or `,`.
2. Keep the current implementation as the first version, unchanged, so the user can compare against it. Write each
   new version as its own component next to it, named after the version (`PricingV2`, `PricingCompact`).
3. Render them through the framework's Variants component, with the current version as the default. The snippet is
   illustrative: the framework packages are not published yet, so the project's Iterbar setup decides the exact import
   and props; follow what the project already uses.

   ```tsx
   import { Variants } from "@iterbar/react";

   <Variants slot="pricing" versions={{ v1: Pricing, v2: PricingV2, v3: PricingCompact }} default="v1" />
   ```

   Use the Svelte component in a Svelte app. In production builds `Variants` renders only the default.
4. Make the versions genuinely different in the dimension the user asked about (layout, density, copy, emphasis),
   and keep everything else equal so the comparison is fair. Each version must work on its own: same props, same
   data, no shared state that only one of them sets.
5. Ask the user to open the page. Once it has loaded, `list_slots` shows the slot with its versions; if the slot is
   missing, the page has not rendered it yet or the bar is not on the page.
6. Tell the user which versions exist and what differs between them, then wait for feedback (below).

## Iterate on comments

Work in a loop, one feedback item at a time, oldest first:

1. At the start of a session, before you have a cursor, call `list_feedback` without filters and keep its `cursor`.
   A listing without a cursor counts everything sent before it as seen, so at the start of a session check every item
   it returns, whatever its status, resolved and done ones included, using the replies each item carries: handle
   `open` and `working` items (an earlier session left those unfinished), and answer any user reply that no later
   agent reply answers, judged by what the replies say, not by who wrote last. A user may have replied after an
   earlier session read the thread and before it replied; that reply comes before the agent's, yet nobody has
   answered it. A user can also reply on a thread after it was resolved, and the reply leaves its status unchanged.
   Such a reply on a resolved or done thread reopens it: `set_status` `working` and handle it like new feedback. A
   thread whose user replies are all answered needs nothing. For that check, call `get_feedback` only when you need an
   item's detail, with `includeAttachments: false` unless you need its screenshot or evidence.
   To pick up what arrived while you worked, call `list_feedback` again without filters and with your latest
   `cursor`: its `events` say what arrived since that cursor (`created` items and `user_reply` answers), and the
   cursor it returns moves past them. Never take work from a filtered listing: it hands your cursor back unchanged,
   so the next wait returns its items again even after you have handled them.
2. For each item, `get_feedback`. Use `target.sourceLocation` (project-relative `path:line:column`), the selector,
   the text excerpt, the screenshot and `activeVariants` to find exactly what the user meant. A comment applies to
   the version that was active when it was sent (`activeVariants`); change that version, not the others, unless the
   user asks otherwise. The evidence attachment holds console, network and error events from around that moment;
   read it when the comment is about broken behavior.
3. `set_status` to `working` before you change code.
4. Make the change. Keep it scoped to what the comment asks.
5. Right before you reply and set a thread done or needs-info, read it again with `get_feedback` so your reply
   covers every user reply in it. Then `reply` with what you changed in a sentence or two (file and version), and
   `set_status` to `done`.
6. When the comment is ambiguous, `reply` with one specific question and `set_status` to `needs-info` instead of
   guessing (read the thread again first, as above). Their answer arrives as a user reply in the same thread.
7. When the user says a thread is finished, or you have answered a question that needs no change, `set_status` to
   `resolved`.

### Batches

The user can collect several comments in the bar's draft tray and send them together. Every item of such a batch has
the same `batchId` (items sent on their own have none). When a `created` event brings an item with a `batchId`, or the
first listing of a session shows unfinished (`open` or `working`) items with one, work through that batch's unfinished
items as one change instead of item by item; leave its items that are already done alone. A later user reply on one item of a batch is about
that thread only: handle it like any reply, without reopening the rest of the batch.

1. `get_batch` with that `batchId`, keeping `includeAttachments` at its default (`true`): look at the screenshots,
   since they show what the user saw. It returns every item of the batch in the order they were sent, each with its
   target, `sourceLocation`, selector, text excerpt and `activeVariants`, and every screenshot (each labelled with its
   item's id). If `complete` is `false` and `lastArrivedAt` is under a minute ago, the rest is still being sent:
   `wait_for_feedback` with your cursor and a `timeoutSeconds` no longer than what is left of that minute, then call
   `get_batch` again. If it is older, the rest will not come; work on
   what is there. Read all of them before you change anything: comments in a batch often relate (the same component, a
   consistent style), and one edit may answer several.
2. `set_status` `working` on every unfinished item of the batch (leave items already done alone). An entry with
   `supersededBy` is an earlier copy of a comment the user sent again (perhaps edited): act on the copy it names, and
   on this one reply that it was sent again and set it `resolved`. If the newest copy asks for the same thing as a
   copy you already finished, do not redo the work: reply on the newest copy that it was already done and set it `done`.
3. Make the changes.
4. For each item you worked on: read it again with `get_feedback` (`includeAttachments: false`), `reply` with what you changed for
   that comment, and `set_status` `done`, or ask and set `needs-info` for that item alone.
5. The batch's items also arrive as separate `created` events; once you have handled the batch, treat those events as
   handled.

When nothing new is left, call `wait_for_feedback` with the latest `cursor` (from the unfiltered `list_feedback`
or the previous wait). It returns when a user sends new feedback or replies in a thread:

- `outcome: "feedback"`: handle each item in `items`; `events` says whether it is new (`created`) or has a new user
  reply (`user_reply` with its `replyId`). Continue with the returned `cursor`.
- `outcome: "timeout"`: nothing arrived. Wait again with the returned `cursor`, or stop.

Before you stop, call `list_feedback` without filters and with your latest cursor once more, and handle what it
returns: a user reply sent after you last read a thread arrives there. Then tell the user you are stopping.

Always pass the most recent cursor, to `list_feedback` as well as to `wait_for_feedback`, so nothing sent while you
were working is missed. Never start over without one once you have it. A filtered `list_feedback` is only for
looking something up. Your own replies and status changes never end a wait. The default timeout is 300 seconds and
the maximum 1,800; if your client gives up on long tool calls, use a shorter `timeoutSeconds` and wait again.

Events are delivered at least once: after a very large burst, or when a wait's timeout cuts its cursor upkeep short,
an event you already got can come back, from either tool. A `created` event is identified by its `feedbackId` and a
`user_reply` event by its `replyId`: remember the ones you have handled (a user reply you read and answered counts)
and skip an event you already handled. Any other event is new, including a user reply that arrived while you were
working, even when your own reply now comes after it: read the thread with `get_feedback` and handle it. The same
check covers an item you acted on after a filtered lookup showed it.

If any tool fails with `daemon_unavailable` during the loop, the user stopped the dev server or daemon. Tell them to
run `iterbar dev` again; keep your cursor, and continue with it once it is back. A failed wait may carry a newer
`cursor` next to its error; use that one when it does.

## Collapse to a chosen version

The user picks a winner with a `choose_variant` feedback item (`choice: { slot, version }`, with an optional note in
`text`), or says so in a comment.

1. `set_status` to `working` on the item.
2. Replace the `Variants` element with the chosen version rendered directly. If the chosen version is not the
   original, move its code to where the original lived and give it the original's name, so imports elsewhere keep
   working.
3. Delete the other versions' components, and remove the slot's leftovers: imports, the Variants import if nothing
   else uses it, and test or story files written only for the discarded versions.
4. Check that the project still builds and its tests pass, and that nothing else referenced the deleted versions
   (search for their names).
5. `reply` with the version that was kept and what was removed, then `set_status` to `done`.

Never collapse a slot without an explicit choice from the user.
