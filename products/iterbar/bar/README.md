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

- **Slots** on the current page, read through the `window.__ITERBAR__` page
  API that `@iterbar/variants` installs. When the bar loads before the
  registry, it waits until the registry appears. With one slot the bar shows
  its name; with more than one, a dropdown chooses which slot's versions to
  show. Choosing a version calls `select()`. Once the registry shows that
  version, the bar writes `slot:version` into the `iterbar` URL parameter with
  `history.replaceState`, keeping every other parameter and the fragment. The
  bar also reports the page's slots to the daemon (`POST /slots`) under the
  page URL without its fragment or `iterbar` parameter.
- **Comment mode**: the Comment button sets `commentMode` and dispatches the
  `iterbar-comment-mode` event (bubbling and composed). See below.
- **Feedback threads**, newest first, with status and replies. The bar lists
  them with `GET /feedback` each time the `/events` WebSocket opens, then
  applies `feedback.created` and `feedback.updated` events as they arrive.
  Each listing replaces the threads, except that a listed copy older than the
  one held never replaces it, and an item that an event delivered while the
  listing was in flight keeps the event's copy against an equal-time listed
  copy and stays when the listing omits it; a strictly newer listed copy
  wins. When the bar no longer holds the content of such a thread, it counts
  the thread without showing a row. If that thread belongs among the newest
  100 shown, the count reads "not shown; updating" and the bar lists again:
  twice at once, then with the reconnect backoff while the stream stays open,
  until a listing or an event carries the content, or newer threads push it
  out of view. A thread older than the shown ones is counted under "older not
  shown" and triggers no further listing. An event replaces an item
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
alone, except Escape, which leaves comment mode from the bar too. The
composer then opens in the bar, which expands if collapsed. Picking another element keeps the typed text, Cancel
drops the pick, and Escape leaves comment mode from anywhere, discarding a
draft not yet posted (see below for one already posted). While comment mode
is off the picker has no page listeners and its outline layer is hidden, so
the page gets every event apart from the bar's Alt+Shift+I shortcut. A page
script's own `element.click()` is never taken for a pick. The picker listens
on `window` in the capture phase, so only capture listeners the page added
to `window` before it can still see picking input.

Send (or Ctrl/Cmd+Enter) creates a `comment` with `POST /feedback`. The
element is described when it is picked:

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
- **Active variants**: the version each slot on the page shows.
- **Screenshot**: a PNG of the element rendered in the page with
  `modern-screenshot` from the pick, at the device pixel ratio, scaled down
  to stay within 4 MP. Every element is drawn alone at the image origin,
  upright at its exact (fractional) border box, scrollbars included, times
  its zoom; a non-replaced inline element at its box on screen. Its own
  transform, margins and offsets and its ancestors' transforms are left out,
  while transforms inside it are kept. An `<svg>` drawing is drawn from a
  copy that carries the SVG styles the page gives it (paint, stroke, text,
  opacity, transforms and geometry, from style sheet rules or inherited)
  and the definitions it uses by `#id` from elsewhere on the page. Paint
  the page gives as `currentColor` (by an attribute, an inline style or a
  rule in a style sheet the page can read) stays `currentColor`, so each
  `<use>` still colours what it shows; any other paint keeps its colour. The size and scale are measured once
  its images and fonts have loaded, so an element that grows meanwhile
  stays within the cap, and the image produced is checked again: one over
  4 MP is not sent. One capture at a time reads, copies and draws the
  element; a capture waiting for its turn holds no copy. A capture withdrawn
  by another pick, Cancel, Escape, the bar's removal or its time limit
  while it copies the element stops at the next node it copies, or its next
  step, and lets the next capture start at once. One withdrawn while it is
  drawn and encoded (which waits on nothing outside the page) finishes
  that first, so the next capture may wait for it, within its own
  10-second limit.
  When the capture fails (for example a canvas tainted by a cross-origin
  image, an element with no area, a scrolled box in the element, which the
  copy would show unscrolled, a shape inside an SVG drawing rather than the
  drawing, a drawing that loads a resource from outside the page (an
  `href` or `url()` that is neither a `#fragment` nor a `data:` URL) or
  holds HTML in a `<foreignObject>`, has padding or a border, or has a
  paint that may be `currentColor` or a colour equal to it (rules that
  disagree, or a custom property), an
  inline element inside a scaled or rotated box, or a capture over 10
  seconds) the comment is still sent, without a screenshot and with the
  reason in `screenshotUnavailableReason`.

  `modern-screenshot` is bundled into `dist/` (its licence is in
  `THIRD-PARTY-NOTICES.md`) rather than imported, so a Vite dev server has no
  extra dependency to discover, and the page needs no reload on first load.

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

- **Alt+Shift+I** collapses or expands the bar from anywhere on the page.
  Expanding moves focus to the bar's toggle.
- Every control is a native button, select or summary, so it can be reached
  with Tab, and each one shows a focus ring.
- Drag the handle (⠿) to dock the bar to any screen edge, or focus the handle
  and press an arrow key. The edge, the position along it and whether the bar
  is collapsed are saved in local storage under `iterbar:bar`, so each origin
  remembers its own.
- Styles stay inside the shadow root. The host resets every inherited
  property with `!important`, which a page rule cannot override, so page CSS
  cannot hide, move or restyle the bar. The bar is shown in the top layer
  (a manual popover), so a `transform`, `filter`, `opacity` or `contain` on
  `html`, `body` or any other ancestor cannot move, cover or hide it, and it
  cancels any `zoom` it inherits.
- Light and dark themes follow `prefers-color-scheme`.
- The bar never loads a remote resource of its own. It uses system fonts and
  text icons, and its network traffic goes to the daemon, except that a
  screenshot re-reads the images and fonts the picked element already uses.

## Tests

- `pnpm test`: unit tests for placement, merging, URL handling, text
  excerpts and screenshot scaling.
- `pnpm test:browser`: Playwright tests in Chromium, against a fake daemon
  built from Playwright routes and against the real daemon from
  `@iterbar/cli`. Install the browser once with
  `pnpm exec playwright install chromium`.
