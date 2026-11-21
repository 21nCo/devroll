/**
 * The bar's only stylesheet, adopted by its shadow root. Nothing here reaches the page, and the page reaches in only
 * through inherited properties and rules on the host element, so:
 *
 * - `:host` resets every property with `!important`. Between a page rule and a `:host` rule that are both
 *   `!important`, the shadow tree's wins, so no page rule can hide, move or restyle the host.
 * - `display: contents` gives the host no box of its own; the bar is a fixed-position child shown in the top layer
 *   (`popover="manual"`), so ancestors that would become its containing block or paint over it have no effect. The
 *   user-agent popover rules (inset, margin, size, border, padding, overflow, colours) are all overridden on `.bar`.
 * - Custom properties are declared on `.bar`, inside the shadow tree, so same-named page variables never apply.
 * - Fonts are system fonts and icons are text: the bar never loads a remote resource.
 */
export const BAR_CSS = String.raw`
:host {
  all: initial !important;
  /* "all" leaves these two alone, so a page's "direction: rtl" would still be inherited. */
  direction: ltr !important;
  unicode-bidi: isolate !important;
  display: contents !important;
}

[hidden] { display: none !important; }

.zoom-probe {
  position: fixed;
  top: 0;
  left: 0;
  width: 100px;
  height: 0;
  visibility: hidden;
  pointer-events: none;
}

.bar, .composer {
  --ib-bg: #ffffff;
  --ib-fg: #16181d;
  --ib-muted: #5a616d;
  --ib-border: #d4d9e1;
  --ib-surface: #f3f5f8;
  --ib-hover: #e8ebf0;
  --ib-accent: #3346c9;
  --ib-accent-fg: #ffffff;
  --ib-accent-soft: rgba(51, 70, 201, 0.12);
  --ib-focus: #3346c9;
  --ib-warn: #8a5a00;
  --ib-danger: #b3261e;
  --ib-shadow: 0 10px 32px rgba(15, 20, 30, 0.18), 0 1px 3px rgba(15, 20, 30, 0.12);
  --ib-margin: 12px;
  color-scheme: light;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-weight: 400;
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  color: var(--ib-fg);
  cursor: auto;
  visibility: visible;
  opacity: 1;
}

@media (prefers-color-scheme: dark) {
  .bar, .composer {
    --ib-bg: #1b1e24;
    --ib-fg: #eceef2;
    --ib-muted: #a6adb9;
    --ib-border: #3a404b;
    --ib-surface: #252930;
    --ib-hover: #30353e;
    --ib-accent: #8ea2ff;
    --ib-accent-fg: #0c1024;
    --ib-accent-soft: rgba(142, 162, 255, 0.18);
    --ib-focus: #a9b8ff;
    --ib-warn: #f2c26b;
    --ib-danger: #ff8a80;
    --ib-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4);
    color-scheme: dark;
  }
}

*, *::before, *::after { box-sizing: border-box; }

/*
 * The dock: a column at the bottom of the viewport, the panel stacked above the toolbar. It is a manual popover in the
 * top layer; the user-agent popover rules (inset, margin, size, border, padding, overflow, colours) are overridden.
 * Only the toolbar and the panel take pointer events, so the dock covers no more of the page than they do.
 */
.dock {
  position: fixed;
  inset: auto;
  bottom: var(--ib-margin);
  z-index: 2147483647;
  display: flex;
  /* The toolbar comes first for the keyboard; the panel shows above it. */
  flex-direction: column-reverse;
  gap: 8px;
  width: max-content;
  max-width: calc(100% - 2 * var(--ib-margin));
  height: auto;
  max-height: calc(100% - 2 * var(--ib-margin));
  margin: 0;
  padding: 0;
  border: 0;
  overflow: visible;
  background: transparent;
  pointer-events: none;
}
.dock[data-dock="left"] { left: var(--ib-margin); align-items: flex-start; }
.dock[data-dock="right"] { right: var(--ib-margin); align-items: flex-end; }
.dock[data-dock="center"] { left: 50%; transform: translateX(-50%); align-items: center; }
/* Woken by the pointer: the left edge holds still (see #holdPlace). Docked right, the controls a wake adds come
   before the sleeping buttons (the status too, whose text appears), so it grows leftward and they stay at the edge. */
.dock[data-dock="right"] .toolbar > .extra,
.dock[data-dock="right"] .toolbar > [data-role=status],
.dock[data-dock="right"] .toolbar > [data-role=drafts-toggle]:not([data-has]) { order: -1; }
.dock[data-held] { left: var(--ib-held-left); right: auto; transform: none; }

.toolbar, .panel { pointer-events: auto; background: var(--ib-bg); border: 1px solid var(--ib-border); box-shadow: var(--ib-shadow); }

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  max-width: 100%;
}
/* Asleep: only the essentials. Awake (pointer, focus, pinned, a panel, the composer or comment mode): everything. The
   pointer wakes it through data-hovered, set once the toolbar's place is held (see #holdPlace), not through :hover. */
.dock:not([data-awake]):not([data-hovered]):not(:focus-within) .extra { display: none; }
.dock:not([data-awake]):not([data-hovered]):not(:focus-within) [data-role=drafts-toggle]:not([data-has]) { display: none; }
.dock:not([data-awake]):not([data-hovered]):not(:focus-within) .toolbar { opacity: 0.92; }
/* Asleep, the connection shows as its dot alone; the text stays for assistive technology. */
.dock:not([data-awake]):not([data-hovered]):not(:focus-within) .status { font-size: 0; gap: 0; padding: 0 8px; }

.divider { width: 1px; align-self: stretch; margin: 4px 4px; background: var(--ib-border); }

button, select {
  font: inherit;
  color: inherit;
  margin: 0;
  background: var(--ib-surface);
  border: 1px solid var(--ib-border);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
}
/* Accent buttons (primary, pressed) keep their colours on hover, so their text stays readable. */
button:hover:not(:disabled):not(.primary):not([aria-pressed="true"]) { background: var(--ib-hover); }
button.primary:hover:not(:disabled), button[aria-pressed="true"]:hover:not(:disabled) { filter: brightness(1.08); }
button[aria-pressed="true"] {
  background: var(--ib-accent);
  border-color: var(--ib-accent);
  color: var(--ib-accent-fg);
}
button[aria-pressed="true"] .muted { color: inherit; }
button.primary { background: var(--ib-accent); border-color: var(--ib-accent); color: var(--ib-accent-fg); }
button:disabled { cursor: default; opacity: 0.55; }

.tool, .icon {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 10px;
  border-radius: 999px;
  border-color: transparent;
  background: transparent;
  white-space: nowrap;
}
.icon { padding: 4px 7px; }
.tool[aria-expanded="true"] { background: var(--ib-accent-soft); color: var(--ib-fg); }
.tool[aria-pressed="true"] { background: var(--ib-accent); color: var(--ib-accent-fg); }
.glyph { flex: none; display: block; }
.count {
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  background: var(--ib-accent);
  color: var(--ib-accent-fg);
}
[data-role=drafts-toggle] .count { background: #9a5b00; color: #ffffff; }

.status { display: inline-flex; align-items: center; gap: 5px; padding: 0 6px; color: var(--ib-muted); font-size: 12px; white-space: nowrap; }
.status::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ib-muted);
}
.status[data-status="connected"]::before { background: #2e9e5b; }
.status[data-status="retrying"]::before, .status[data-status="connecting"]::before { background: #d69a1d; }
.status[data-status="unauthorized"]::before, .status[data-status="invalid"]::before { background: #d24b4b; }
/* Asleep, a connection problem still shows as a dot on the inbox button. */
.dock:not([data-awake]):not([data-hovered]):not(:focus-within):is([data-status="unauthorized"], [data-status="invalid"], [data-status="retrying"]) [data-role=inbox-toggle]::after {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d24b4b;
}

/* The panel: inbox, draft tray or versions, opening upward from the toolbar. */
.panel {
  display: flex;
  flex-direction: column;
  width: min(400px, calc(100vw - 2 * var(--ib-margin)));
  max-height: min(70vh, 560px);
  border-radius: 12px;
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--ib-border);
}
.panel-title { margin: 0 auto 0 0; font-size: 13px; font-weight: 600; }
.panel-body {
  overflow: auto;
  /* Room for a scrollbar is kept whether or not one shows, so opening a thread never shifts the content sideways. */
  scrollbar-gutter: stable;
  padding: 10px 8px 12px 14px;
}

.section { margin: 0; }
.section-title { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ib-muted); }
p { margin: 0 0 6px; }
.muted { color: var(--ib-muted); }
.detail { color: var(--ib-warn); margin: 0 0 10px; overflow-wrap: anywhere; }
.spacer { flex: 1; }

:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--ib-focus);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--ib-bg);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.field { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.field select { flex: 1; min-width: 0; }
.slot-name strong { font-weight: 600; }
.versions { display: flex; flex-wrap: wrap; gap: 4px; }
.warnings { margin: 6px 0 0; padding-left: 16px; color: var(--ib-warn); font-size: 12px; }

.filters { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.chip { border-radius: 999px; padding: 2px 10px; font-size: 12px; }

.threads, .drafts { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.thread details { border: 1px solid var(--ib-border); border-radius: 8px; background: var(--ib-surface); }
.thread summary {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  cursor: pointer;
  list-style: none;
  border-radius: 8px;
}
.thread summary::-webkit-details-marker { display: none; }
.thread-head { display: flex; align-items: center; gap: 6px; }
/* Long comments wrap rather than being cut at the panel's edge; closed threads show the first three lines. */
.thread-text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.thread details[open] .thread-text { display: block; -webkit-line-clamp: none; overflow: visible; }
.thread-count { margin-left: auto; color: var(--ib-muted); font-size: 11px; white-space: nowrap; }
.thread-body { padding: 0 10px 10px; display: grid; gap: 6px; }
.thread-meta { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.replies { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.reply { margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--ib-bg); border: 1px solid var(--ib-border); min-width: 0; }
.reply[data-author="agent"] { border-left: 3px solid var(--ib-accent); }
.reply-author { display: block; font-size: 11px; font-weight: 600; color: var(--ib-muted); }
.reply-text { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.badge {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--ib-border);
  color: var(--ib-fg);
}
.badge[data-status="working"] { background: #d69a1d; color: #1b1300; }
.badge[data-status="needs-info"] { background: #d24b4b; color: #ffffff; }
.badge[data-status="done"], .badge[data-status="resolved"] { background: #2e9e5b; color: #ffffff; }

.draft {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ib-border);
  border-radius: 8px;
  background: var(--ib-surface);
}
.draft[data-state="failed"] { border-color: var(--ib-danger); }
.draft[data-state="sending"] { opacity: 0.7; }
.draft-index {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #9a5b00;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
}
.draft-body { flex: 1; min-width: 0; display: grid; gap: 4px; }
.draft-target { margin: 0; font-size: 12px; color: var(--ib-muted); overflow-wrap: anywhere; }
.draft-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.draft-actions { display: flex; gap: 6px; }
.draft-actions button { padding: 1px 8px; font-size: 12px; }
.drafts-footer { margin-top: 10px; display: grid; gap: 6px; }
.empty { margin: 0; }

/* The composer: a popover anchored next to the picked element. */
.composer {
  position: fixed;
  inset: auto;
  top: 0;
  left: 0;
  z-index: 2147483647;
  display: grid;
  gap: 6px;
  width: min(340px, calc(100vw - 2 * var(--ib-margin)));
  height: auto;
  /* Never taller than the viewport, so its buttons stay reachable; it scrolls instead. */
  max-height: calc(100vh - 2 * var(--ib-margin));
  margin: 0;
  padding: 10px;
  overflow: auto;
  color: var(--ib-fg);
  background: var(--ib-bg);
  border: 1px solid var(--ib-border);
  border-radius: 10px;
  box-shadow: var(--ib-shadow);
  pointer-events: auto;
}
.composer .section-title { margin: 0; }
.composer-target { margin: 0; color: var(--ib-muted); overflow-wrap: anywhere; cursor: help; }
.composer-text {
  font: inherit;
  color: inherit;
  width: 100%;
  min-height: 4.5em;
  margin: 0;
  padding: 6px 8px;
  resize: vertical;
  background: var(--ib-bg);
  border: 1px solid var(--ib-border);
  border-radius: 6px;
}
.composer-hint { margin: 0; font-size: 11px; }
.composer-error { margin: 0; color: var(--ib-danger); overflow-wrap: anywhere; }
.composer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

/* Comment mode's outlines: a full-viewport top-layer layer that never takes pointer events. */
.pick-layer {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: transparent;
  color: inherit;
  pointer-events: none;
}
.pick-layer:not([data-active]):not([data-marking]) { display: none; }
.pick-box {
  position: absolute;
  top: 0;
  left: 0;
  border: 2px dashed #2f4fd0;
  border-radius: 2px;
  background: rgba(47, 79, 208, 0.08);
  pointer-events: none;
}
.pick-box.picked { border-style: solid; background: rgba(47, 79, 208, 0.14); }
.pick-box.marked { border: 2px solid #c77700; background: rgba(199, 119, 0, 0.12); }
`;

let shared: CSSStyleSheet | null = null;

/** Gives `root` the bar's stylesheet: one constructed sheet shared by every bar, or a `<style>` element where unsupported. */
export function applyBarStyles(root: ShadowRoot): void {
  if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
    if (!shared) {
      shared = new CSSStyleSheet();
      shared.replaceSync(BAR_CSS);
    }
    root.adoptedStyleSheets = [shared];
    return;
  }
  const style = document.createElement("style");
  style.textContent = BAR_CSS;
  root.append(style);
}
