# @iterbar/bar

The Iterbar dev bar: `<iterbar-bar>`, a framework-free custom element that
renders in its own shadow root. It is meant for development pages only; the
Vite plugin injects it with the daemon's address and token.

```ts
import { mountIterbarBar } from "@iterbar/bar";

// Defines <iterbar-bar> and adds one to document.body (or reuses the page's).
const bar = mountIterbarBar({ daemonUrl: "http://127.0.0.1:41234", token });
bar.addEventListener("iterbar-comment-mode", (event) => console.log(event.detail.active));
```

`defineIterbarBar()` only registers the element. You can then set the
`daemonUrl` and `token` properties, or the `daemon-url` and `token`
attributes. The bar never writes the token to an attribute.

## What it shows

The bar is a toolbar docked at the bottom of the page. Collapsed (the default)
it shows only the Iterbar logo. Clicking the logo, or **Ctrl/Cmd+.**,
expands it (Comment, Inbox with its open count, Drafts, Variants and, at its
end, Help); clicking it again collapses it. Hovering and focus
never expand it; a panel, the composer or comment mode show the whole toolbar
while they last. The logo stays where it is when the toolbar expands, and
dragging it (or the arrow keys, Home and End on it) moves the toolbar along
the bottom edge. The place, the expanded state and the open panel are
remembered per project. The inbox, the draft tray and Help open as a
full-height sheet on the right of the screen (stopping above the toolbar when
the toolbar is under it); Variants opens as a fixed-height popover above the
toolbar.

**Comment pins.** Each thread on the current page that is still open, in
progress or needing info shows a small comment pin on the top-right corner of
its element, found again by the selector the bar recorded when the comment was
picked (one pin per element, with a count when there are several). A pin
follows its element as the page scrolls, resizes or changes; it hides while the
element is gone, hidden or out of view, and goes once the thread is done or
archived. Clicking it opens the inbox at that thread. An element the recorded
selector no longer finds (the page changed shape, or it is in a closed shadow
root or a frame) gets no pin; its thread is still in the inbox.

Keys typed into the bar's own fields (the composer, a draft being edited, the
slot list) stop at the bar, so the page's keyboard shortcuts never see them.

- **Variants**: the slots on the current page, read through the `window.__ITERBAR__` page
  API that `@iterbar/variants` installs. When the bar loads before the
  registry, it waits until the registry appears. With one slot the bar shows
  its name; with more than one, a dropdown chooses which slot's variants to
  show, one row each. Choosing a variant calls `select()` (the page API and
  the protocol call a slot's variants its "variants"). Once the registry shows that
  variant, the bar writes `slot:variant` into the `iterbar` URL parameter with
  `history.replaceState`, keeping every other parameter and the fragment. The
  bar also reports the page's slots to the daemon (`POST /slots`) under the
  page URL without its fragment or `iterbar` parameter.
- **Comment mode**: the Comment button (or **C** anywhere outside a text
  field) sets `commentMode` and dispatches the `iterbar-comment-mode` event
  (bubbling and composed). See below.
- **Draft tray**: comments picked and written but kept in the page (in
  memory, for this tab) until **Send all** posts them, in order, as one batch.
  Each draft can be edited or removed first, and hovering one outlines its
  element. Every comment of a batch carries the same `batchId` and the
  batch's `batchSize`, which agents read with the MCP `get_batch` tool (it
  says whether the whole batch has arrived). A draft the daemon refuses stays
  in the tray with the reason, and Send all retries it in the same batch,
  with any drafts added since. A draft added while a batch is being sent
  waits for the next Send all.
- **Inbox**: the feedback threads, newest first, with status (Open, In
  progress, Needs info, Done, Archived; an agent's older `resolved` shows as
  Done), the target and page, and replies, which arrive live. Filter pills,
  each with its count, show all threads but archived ones, open ones (open or
  needing info), those in progress, those done, or archived ones. The panel
  keeps one height whatever the filter; the list scrolls inside it, 25 threads
  at a time with **Show 25 more** and an "N of M" count. Threads can be
  selected with their checkbox (Shift for a range), Ctrl/Cmd-click, or by
  dragging across rows, then marked done, reopened, archived or deleted
  together (`POST /feedback/:id/status`, `DELETE /feedback/:id`); each opened
  thread offers the same actions. A delete waits six seconds with an Undo
  before it is sent (at once if the page goes away). Escape clears a
  selection, then closes the panel. Long comments and replies wrap.
  The bar keeps the newest 500 threads; older ones are counted as not loaded.
  The bar lists
  them with `GET /feedback` each time the `/events` WebSocket opens, then
  applies `feedback.created`, `feedback.updated` and `feedback.deleted`
  events as they arrive.
  Each listing replaces the threads, except that a listed copy older than the
  one held never replaces it, and an item that an event delivered while the
  listing was in flight keeps the event's copy against an equal-time listed
  copy and stays when the listing omits it; a strictly newer listed copy
  wins. When the bar no longer holds the content of such a thread, it counts
  the thread without showing a row. If that thread belongs among the newest
  500 kept, the count reads "not shown; updating" and the bar lists again:
  twice at once, then with the reconnect backoff while the stream stays open,
  until a listing or an event carries the content, or newer threads push it
  out of view. A thread older than the kept ones is counted as not loaded and
  triggers no further listing. An event replaces an item
  unless it is older (`updatedAt`) than the one held.
  Events that are malformed or from another schema version are ignored.
  Switching to another daemon URL or token clears the threads.

## Comment mode

While comment mode is on, hovering outlines the page element under the
pointer, and clicking one (or pressing Enter or Space on a focused page
element, a text field included, where the key then types nothing) picks it
instead of reaching the page: the press, the click, the focus change, a
context menu and the key, with its repeats and release, are all swallowed,
including presses on the document root, which is never picked itself. That
key stops being swallowed once it is released, the window loses focus or is
hidden, or it is pressed again. Clicks and keys inside the bar are left
alone, except Escape, which leaves comment mode from the bar too. The pointer
is a crosshair over the page (an inline `cursor` on the root element while
comment mode is on). The composer then opens as a small popover next to the
picked element: below it, or above it when there is no room below. It names
the element readably, by its accessible name or a short excerpt of its text
and the source file and line when known (`On “Suggestions” · AskBox.svelte:45`),
with the full source location and the selector in its tooltip. Picking another element keeps the typed text, Cancel
drops the pick, and Escape leaves comment mode from anywhere, discarding a
draft not yet posted (see below for one already posted). While comment mode
is off the picker has no page listeners and its outline layer is hidden, so
the page gets every event apart from the bar's shortcuts (Ctrl/Cmd+., C
outside text fields, and Alt+Shift+I). A page
script's own `element.click()` is never taken for a pick. The picker listens
on `window` in the capture phase, so only capture listeners the page added
to `window` before it can still see picking input.

**Add draft** (or Ctrl/Cmd+Enter) moves the comment into the draft tray and
leaves comment mode on for the next pick; its screenshot carries on in the
background. **Send** (or Ctrl/Cmd+Shift+Enter) creates the `comment` at once,
on its own, with `POST /feedback`, and ends comment mode. The element is
described when it is picked:

- **Selector**: from a closed set, tried in order: `[data-testid="…"]` when
  that test id is unique, `#id` when unique, then a tag/class/`:nth-of-type`
  child path from the nearest element (the picked one included) whose
  `data-iterbar-src` stamp or `data-iterbar-slot` name is unique, or from
  `:root` when there is none. Every selector is checked to resolve back to
  the picked element alone. Elements inside a page's shadow roots and iframes
  cannot be picked yet.
- **Text excerpt**: the rendered text with whitespace collapsed, at most 200
  characters.
- **Bounding box**: the border box in CSS pixels from the top-left corner of
  the document.
- **Source location**: the nearest well-formed `data-iterbar-src`, or `null`.
- **Active variants**: the variant each slot on the page shows.
- **Screenshot**: a PNG of the element rendered in the page with
  `modern-screenshot` from the pick, at the device pixel ratio, scaled down
  to stay within 4 MP. Every element is drawn alone at the image origin,
  upright at its exact (fractional) border box, scrollbars included, times
  its zoom; a non-replaced inline element at its box on screen. Its own
  transform, margins and offsets and its ancestors' transforms are left out,
  while transforms inside it are kept. An `<svg>` drawing is drawn from a
  copy of its markup, with the definitions it uses by `#id` from elsewhere
  on the page. Its root carries what the drawing inherits from the page.
  The copy is first checked in a hidden, sandboxed frame inside the bar
  that has none of the page's style sheets: each copied element must
  compute every style property (custom properties too) as its original
  does. What the page's rules give an element (a fill, opacity,
  transform, `d`, box-sizing or custom property) is given to its copy as
  computed (an empty custom property stays empty), and then every
  element is compared again, unless the copy has no style sheet of its
  own and has not changed since the element matched in every property.
  What a `<use>` shows is drawn with only its
  own attributes and inline style, the drawing's own rules and what it
  inherits from the `<use>`, which comparing elements cannot check for each
  `<use>`; so the screenshot is unavailable when the page could style it
  otherwise: a page style sheet it cannot read (another origin's), any
  page rule matching a shown element at any nesting or under any
  condition (a universal reset such as Tailwind's matches every element),
  one of the drawing's own rules that is nested, conditional or matches
  the copy differently, or a custom property the page registers
  (`@property` or `CSS.registerProperty`) that shown content uses. Rules
  are matched widened: `&` as its parent's selector, `:scope` and a
  namespace prefix as anything, and a `:not()`, `:nth-child(… of …)` or
  other non-monotone pseudo-class holding one (or under a default
  namespace) as anything. A drawing with text is unavailable (an image
  cannot be shown to use the page's font or rasterise it alike), as are a
  `#id` link the URL parser changes (a `%` escape, a tab or newline inside
  it), an attribute, own style sheet or value given to the copy with a
  character the image's markup drops (a control character, a lone
  surrogate, U+FFFE, U+FFFF), an SVG
  animation element in the drawing or one elsewhere targeting it, and
  `<use>` content a CSS animation moves. Otherwise transitions and
  animations are drawn as they are at that moment. Pointing, selection and
  list-marker properties (`cursor`, `pointer-events`, `user-select`,
  `-webkit-user-select`, `list-style-image`) are left out of the copy, as is
  a custom property that refers to an image. The size and scale are measured
  once its images and fonts have loaded, so an element that grows meanwhile
  stays within the cap, and the image produced is checked again: one over
  4 MP is not sent. One capture at a time reads, copies, checks and draws
  the element; a capture waiting for its turn holds no copy. A capture
  withdrawn by another pick, Cancel, Escape, the bar's removal or its time
  limit while it copies or checks the element stops at the next node it
  copies or checks, or its next step, removes its frame and lets the next
  capture start at once. One withdrawn while it is
  drawn and encoded (which waits on nothing outside the page) finishes
  that first, so the next capture may wait for it, within its own
  10-second limit.
  The element is copied just after the pick, not at the pick itself: a
  large element, or one waiting for its images, may be copied with changes
  the page made meanwhile in answer to later pointer, keyboard or scroll
  input (its `:hover` styles once the pointer moves to the composer, say).
  Holding the copy to the picked state under such input is deferred to
  ROLL-20.
  When the capture fails (for example a canvas tainted by a cross-origin
  image, an element with no area, focus on any page element when it is
  picked (so a keyboard pick, too), which the composer then takes, so focus
  styles and blur handlers could change it before it is copied, a
  scrolled box in the element, which the
  copy would show unscrolled, a shape inside an SVG drawing rather than the
  drawing, a drawing that loads a resource from outside the page (an
  `href`, or a `url()` or `src()` in a style or
  presentation attribute, an inherited value or its own `<style>` text,
  that is neither a `#fragment` nor a `data:` URL; an `@import`; an
  `image-set()`), holds HTML in a `<foreignObject>`, has
  padding or a border, or that the page styles in a way its copy cannot reproduce,
  an inline element inside a scaled or rotated box, or a capture over 10
  seconds) the comment is still sent, without a screenshot and with the
  reason in `screenshotUnavailableReason`.

  `modern-screenshot` is bundled into `dist/` (its licence is in
  `THIRD-PARTY-NOTICES.md`) rather than imported, so a Vite dev server has no
  extra dependency to discover, and the page needs no reload on first load.
  The bundled copy is patched (`patches/modern-screenshot@4.7.0.patch` at the
  repository root, applied by pnpm) to escape the id of a `<use href="#…">`
  target before it builds a selector, so an icon sprite id such as
  `ph:sparkle` no longer fails the capture.

The page URL is filed as for slot reports. While Send waits for the
screenshot, Cancel or Escape withdraws the comment and nothing is posted.
Once it is posted it can no longer be withdrawn: Cancel is disabled, and
Escape ends comment mode but leaves the composer saying "Sending…" until the
daemon answers. On success the thread appears in the bar and comment mode
ends. A send the daemon refuses (a 4xx answer, which stores nothing) keeps
the composer open with the text and the daemon's reason, so it can be sent
again. A send that fails in the daemon (a 5xx answer, with its reason) or
gets no answer (a lost connection or no answer within 10 seconds) also keeps
the text, but says the comment may already be stored, since the daemon
stores it before its last steps and its answer: check the threads, where a
stored comment appears, before sending it again. Sends are never retried automatically.

## Connection

The daemon URL must be `http://127.0.0.1:<port>` with nothing after it, and
the token must be 64 lowercase hex characters; otherwise the bar never sends
a request. Without either value, it still switches slots and shows that
feedback is unavailable.

If the event stream drops, the bar reconnects with backoff (1 s up to 30 s,
reset only after a listing succeeds) and lists the threads again. Only the
latest slot report is ever retried. A page whose origin is not registered with
`POST /origins` cannot read any daemon response, so it keeps retrying and
says so. A rejected token (`401`) stops the bar until it gets a new token.
Removing the element closes the stream and cancels every timer.

## Layout, keyboard and styling

- **Ctrl/Cmd+.** expands or collapses the toolbar from anywhere on the page;
  expanding moves focus to the Comment button, collapsing moves focus that was
  in the toolbar to the logo (Alt+Shift+I does the same). **C** toggles comment mode. Neither shortcut applies while focus is
  in a text field, an editable element or a custom element whose shadow root
  the bar cannot read (it may hold a field); the toolbar's buttons still work. **Escape** leaves comment mode, cancels a draft being edited,
  clears an inbox selection, or closes the open panel and returns focus to its
  button.
- Every control is a native button, select or summary, so it can be reached
  with Tab in visual order (the toolbar, then the open panel), and each one
  shows a focus ring. Counts, the connection and what a send did are
  announced to screen readers.
- The toolbar sits 20 px above the bottom edge. While it is awake, a grab
  handle shows at its start: drag it to move the toolbar anywhere along the
  bottom edge (it stops at the margins), or focus it and press ← and → (Shift
  for bigger steps), Home or End. The position is kept as a share of the room
  between the margins, so the toolbar stays in view at any window width. The
  panel above it is placed by the same share over its own width, so it stays
  in view too. Past two thirds of the way along, the toolbar runs right to
  left. Expanding it never moves the logo: the toolbar grows away from it,
  and what does not fit wraps onto a row above.
- The position, whether the toolbar stays expanded, the open panel, the inbox
  filter and the agent chosen in "Use with your agent" are saved in local
  storage under `iterbar:toolbar:<project>` when the bar is given a `project`
  (the Vite plugin passes the project's root), or `iterbar:toolbar` for the
  whole origin otherwise. The toolbar and panel take pointer events only
  where they are drawn.
- Every toolbar control has an accessible name and a tooltip, shown on hover
  (after a short delay) and on keyboard focus: a short label, its shortcut
  where there is one, and for some a line that explains it.
- The Help button (a question mark at the toolbar's end) opens the setup
  sheet. Its top shows the connection: a dot, its label and what it means.
  "Connected" means the bar's link to the project's Iterbar daemon is open, so
  comments are saved for a coding agent, which reaches the same daemon on its
  own through `iterbar mcp`; offline, comments stay as drafts, and the Help
  button carries a red dot. Below it, for Claude Code, Codex, Cursor or another
  MCP client: the one-time `npx iterbar init` command (with the project's path
  filled in when the bar knows it), a prompt to paste, and the same setup by
  hand, each with a copy button. The draft tray links to it too.
- On a page without variants, Variants lists the pages that have some, with
  each page's variant and slot counts (from the daemon's `GET /slots`: pages
  opened with the bar since the daemon started), each a link to that page.
- Styles stay inside the shadow root. The host resets every inherited
  property with `!important`, which a page rule cannot override, so page CSS
  cannot hide, move or restyle the bar. The bar is shown in the top layer
  (a manual popover), so a `transform`, `filter`, `opacity` or `contain` on
  `html`, `body` or any other ancestor cannot move, cover or hide it, and it
  cancels any `zoom` it inherits.
- Light and dark themes follow `prefers-color-scheme`.
- It looks like the 21n apps: the tidigit iris colour scheme's tokens from
  `@21n/theme`, the Twenty One Native typeface from `@21n/fonts` and Phosphor
  Light icons from `@iconify-json/ph` (`scripts/phosphor-icons.mjs` writes the
  icons it uses into `src/phosphor.ts`).
- The bar never loads a remote resource of its own. The build bundles its two
  Twenty One Native weights as data URLs and registers them under a family
  name of its own, so the page's fonts are unchanged; icons are inline SVG.
  Its network traffic goes to the daemon, except that a screenshot re-reads
  the images and fonts the picked element already uses.

## Tests

- `pnpm test`: unit tests for stored state, composer placement, labels, merging, URL handling, text
  excerpts and screenshot scaling.
- `pnpm test:browser`: Playwright tests in Chromium, against a fake daemon
  built from Playwright routes and against the real daemon from the
  `iterbar` CLI package. Install the browser once with
  `pnpm exec playwright install chromium`.
