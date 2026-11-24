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
 * - The look is the 21n one: the tidigit iris colour scheme's tokens (@21n/theme: bgs, fgs, brs, aps, ags, ars), the
 *   Twenty One Native typeface (bundled, see fonts.ts) and Phosphor Light icons (inline, see icons.ts). The bar never
 *   loads a remote resource.
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
  /* 21n tokens, tidigit iris light (cs_tidigit_light_iris in @21n/theme's colorschemes.json). */
  --ib-bg: hsl(0 0% 99%);         /* bgs1 */
  --ib-surface: hsl(0 0% 97%);    /* bgs2 */
  --ib-hover: hsl(0 0% 94%);      /* bgs3 */
  --ib-fg: hsl(0 0% 20%);         /* fgs1 */
  --ib-fg2: hsl(0 0% 33%);        /* fgs2 */
  --ib-muted: hsl(0 0% 42%);      /* fgs3, darkened so small muted text passes 4.5:1 on every surface */
  --ib-border: hsl(45 17% 91%);   /* brs3 */
  --ib-accent: hsl(239 55% 58%);  /* aps1 */
  --ib-accent-fg: hsl(0 0% 99%);  /* the scheme's text on accent: bgs1 */
  --ib-accent-soft: hsl(245 59% 89%); /* aps2 */
  --ib-link: hsl(239 55% 58%);    /* aps1 */
  --ib-focus: hsl(239 55% 58%);   /* aps1 */
  --ib-success: hsl(151 66% 42%); /* ags1 */
  --ib-success-text: hsl(151 66% 26%); /* ags1 darkened so small success text passes 4.5:1 */
  --ib-danger: hsl(0 89% 71%);    /* ars1 */
  --ib-danger-text: hsl(0 60% 48%);
  /* Rhombus's "needs you" amber (--rh-warn), a shade darker so white text on it passes 4.5:1. */
  --ib-warn: rgb(150 92 20);
  --ib-warn-fg: hsl(0 0% 99%);
  /* Text on the green and red status fills (ags1, ars1): dark in both themes, for 4.5:1 contrast. */
  --ib-on-status: hsl(228 26% 11%);
  --ib-tip-bg: hsl(0 0% 20%);     /* fgs1 */
  --ib-tip-fg: hsl(0 0% 99%);     /* bgs1 */
  --ib-shadow: 0 10px 32px rgba(15, 20, 30, 0.14), 0 1px 3px rgba(15, 20, 30, 0.10);
  --ib-margin: 12px;
  --ib-bottom: 20px;
  color-scheme: light;
  font: 13px/1.4 "Iterbar Twenty One Native", "Twenty One Native", ui-sans-serif, system-ui, sans-serif;
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
    /* tidigit iris dark (cs_tidigit_dark_iris). */
    --ib-bg: hsl(228 26% 11%);
    --ib-surface: hsl(229 19% 15%);
    --ib-hover: hsl(229 19% 18%);
    --ib-fg: hsl(0 0% 95%);
    --ib-fg2: hsl(0 0% 79%);
    --ib-muted: hsl(0 0% 65%);
    --ib-border: hsl(229 19% 25%);
    --ib-accent: hsl(239 55% 58%);
    --ib-accent-fg: hsl(0 0% 99%);
    --ib-accent-soft: hsl(245 57% 25%);
    /* aps1 lightened so link text passes 4.5:1 on the dark surfaces. */
    --ib-link: hsl(239 70% 74%);
    --ib-focus: hsl(239 70% 72%);
    --ib-success: hsl(151 66% 42%);
    --ib-success-text: hsl(151 66% 48%);
    --ib-danger: hsl(0 89% 71%);
    --ib-danger-text: hsl(0 89% 71%);
    --ib-warn: rgb(226 170 90);
    --ib-warn-fg: hsl(228 26% 11%);
    --ib-tip-bg: hsl(0 0% 95%);
    --ib-tip-fg: hsl(228 26% 11%);
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
  bottom: var(--ib-bottom);
  /* Set by the bar (see #layout): the logo sits at the stored position and the expanded toolbar grows away from it. */
  left: var(--ib-left, calc(50% - 19px));
  z-index: 2147483647;
  display: flex;
  /* The dock is the toolbar's box; the panel (first for the keyboard after the toolbar) is placed above it on its own. */
  flex-direction: column;
  width: max-content;
  max-width: calc(100% - 2 * var(--ib-margin));
  height: auto;
  max-height: calc(100% - var(--ib-margin) - var(--ib-bottom));
  margin: 0;
  padding: 0;
  border: 0;
  overflow: visible;
  background: transparent;
  pointer-events: none;
}
/* Past two thirds of the way along, the toolbar runs right to left, so it expands away from the edge with the logo at
   its right end. */
.dock[data-align="end"] .toolbar { flex-direction: row-reverse; }
/* Running right to left, the status's label grows leftward, away from its dot. */
.dock[data-align="end"] .status { flex-direction: row-reverse; padding: 0 7px 0 8px; }
.dock[data-dragging], .dock[data-dragging] * { cursor: grabbing !important; user-select: none; }

.toolbar, .panel { pointer-events: auto; background: var(--ib-bg); border: 1px solid var(--ib-border); box-shadow: var(--ib-shadow); }

/* Short of room, controls wrap onto rows above the first one (wrap-reverse), which keeps the sleeping buttons where
   they are. */
.toolbar {
  position: relative;
  display: flex;
  flex-wrap: wrap-reverse;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 20px;
  max-width: 100%;
}
/* Collapsed: only the logo. Expanded (or while a panel, the composer or comment mode needs it): everything. Hovering
   never expands it; clicking the logo does. */
.dock:not([data-awake]) .toolbar > :not(.logo) { display: none; }

/* The Iterbar logo: the collapsed toolbar, the expanded toolbar's first control, and the handle that moves it. */
.logo {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--ib-accent) !important;
  color: var(--ib-accent-fg);
  cursor: pointer;
  touch-action: none;
  transition: filter 120ms ease, transform 120ms ease;
}
.logo:hover { filter: brightness(1.08); }
.logo:active { transform: scale(0.96); }
.dock[data-dragging] .logo { transform: none; }
.logo-mark { display: block; }
/* Collapsed, a connection problem still shows as a dot on the logo's corner. */
.dock:not([data-awake]):is([data-status="unauthorized"], [data-status="invalid"], [data-status="retrying"]) .logo::after {
  content: "";
  position: absolute;
  top: -1px;
  right: -1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--ib-bg);
  background: var(--ib-danger);
}
.dock[data-awake] .logo { margin-right: 2px; }
.dock[data-awake][data-align="end"] .logo { margin-right: 0; margin-left: 2px; }

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
.tool { color: var(--ib-fg2); }
.tool:hover:not(:disabled) { color: var(--ib-fg); }
.tool[aria-expanded="true"] { background: var(--ib-accent-soft); color: var(--ib-fg); }
.tool[aria-pressed="true"] { background: var(--ib-accent); color: var(--ib-accent-fg); }
.glyph { flex: none; display: block; }
.count {
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
  background: var(--ib-accent);
  color: var(--ib-accent-fg);
}
[data-role=drafts-toggle] .count { background: var(--ib-warn); color: var(--ib-warn-fg); }

/* The connection: a dot and its label, one element with a tooltip that explains it. */
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 8px 0 7px;
  border-radius: 999px;
  color: var(--ib-muted);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  border-color: transparent;
  background: transparent;
}
.status[aria-expanded="true"] { background: var(--ib-accent-soft); color: var(--ib-fg); }
.status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ib-muted); }
.status-dot[data-status="connected"] { background: var(--ib-success); }
.status-dot[data-status="retrying"], .status-dot[data-status="connecting"] { background: var(--ib-warn); }
.status-dot[data-status="unauthorized"], .status-dot[data-status="invalid"] { background: var(--ib-danger); }


/* Tooltips for the toolbar's controls: a short label, the shortcut where there is one, and for the connection a line
   that explains it. Shown on hover (after a short delay) and on keyboard focus. */
.tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 1;
  display: grid;
  gap: 2px;
  width: max-content;
  max-width: 260px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--ib-tip-bg);
  color: var(--ib-tip-fg);
  font-size: 12px;
  line-height: 1.35;
  pointer-events: none;
  white-space: normal;
}
.tooltip-label { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.tooltip-detail { opacity: 0.85; }
.tooltip kbd {
  font: inherit;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--ib-tip-fg) 35%, transparent);
  opacity: 0.9;
}

/* The panel: inbox, draft tray, variants or "Use with your agent", opening upward from the toolbar. The bar lines it
   up with the toolbar and keeps it in view (see #layout). */
.panel {
  --ib-panel-width: min(400px, calc(100vw - 2 * var(--ib-margin)));
  --ib-panel-max: calc(100vh - var(--ib-bottom) - var(--ib-toolbar-height, 40px) - 8px - var(--ib-margin));
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  display: flex;
  flex-direction: column;
  width: var(--ib-panel-width);
  max-height: min(70vh, 560px, calc(100vh - var(--ib-bottom) - var(--ib-toolbar-height, 40px) - 8px - var(--ib-margin)));
  border-radius: 12px;
  overflow: hidden;
}
/* The inbox keeps one height whichever filter is chosen; its list scrolls inside it. */
.panel[data-panel="inbox"] { --ib-panel-width: min(440px, calc(100vw - 2 * var(--ib-margin))); height: min(540px, 72vh, var(--ib-panel-max)); max-height: none; }
.panel[data-panel="inbox"] .panel-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding-bottom: 0; }
/* "Use with your agent" holds commands and config, so it takes more width. */
.panel[data-panel="agent"] { --ib-panel-width: min(480px, calc(100vw - 2 * var(--ib-margin))); max-height: min(78vh, 640px, calc(100vh - var(--ib-bottom) - var(--ib-toolbar-height, 40px) - 8px - var(--ib-margin))); }
.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--ib-border);
}
.panel-title { margin: 0 auto 0 0; font-size: 13px; font-weight: 500; }
.panel-body {
  overflow: auto;
  /* Room for a scrollbar is kept whether or not one shows, so opening a thread never shifts the content sideways. */
  scrollbar-gutter: stable;
  padding: 10px 8px 12px 14px;
}

.section { margin: 0; }
.section-title { margin: 0 0 8px; font-size: 11px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ib-muted); }
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

/* Variants: the slot (named, or chosen from a list), then one row per variant. */
.slot-name { display: flex; align-items: baseline; gap: 6px; margin: 0 0 12px; font-size: 12px; }
.slot-name strong { font-weight: 500; font-size: 13px; color: var(--ib-fg); }
.slot-picker { position: relative; margin: 0 0 12px; }
.slot-picker select {
  appearance: none;
  width: 100%;
  min-height: 32px;
  padding: 5px 30px 5px 10px;
  border-radius: 8px;
  background: var(--ib-surface);
  font-weight: 500;
}
.slot-picker .glyph { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ib-muted); pointer-events: none; }
.variants { display: grid; gap: 6px; }
.variants .variant {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 8px;
  text-align: left;
  background: var(--ib-surface);
  color: var(--ib-fg);
}
.variants .variant[aria-pressed="true"] { background: var(--ib-accent-soft); border-color: var(--ib-accent); color: var(--ib-fg); }
.variants .variant[aria-pressed="true"]:hover:not(:disabled) { filter: none; }
.variant-name { font-weight: 500; overflow-wrap: anywhere; }
.variant-tag { font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 999px; background: var(--ib-hover); color: var(--ib-muted); }
.variant-check { margin-left: auto; color: var(--ib-accent); visibility: hidden; }
.variant-check .glyph { width: 15px; height: 15px; }
.variant[aria-pressed="true"] .variant-check { visibility: visible; }
.warnings { margin: 12px 0 0; padding-left: 16px; color: var(--ib-warn); font-size: 12px; }

.filters { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.chip { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.chip-count { margin-left: 5px; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.chip[aria-pressed="true"] .chip-count { color: inherit; opacity: 0.8; }

/* The inbox: filters and the selection row stay put; the threads scroll below them. */
.inbox { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.bulk { display: flex; align-items: center; gap: 6px; min-height: 30px; margin: 0 0 6px; }
.bulk-text { font-size: 12px; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.inbox[data-selecting] .bulk-text { color: var(--ib-fg); font-weight: 500; }
.bulk-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.inbox[data-busy] .bulk-actions, .inbox[data-busy] .thread-actions { opacity: 0.6; }
.threads-scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  margin: 0 -8px 0 0;
  padding: 0 8px 12px 0;
  overscroll-behavior: contain;
}
.threads-scroller .empty { margin: 16px 0 0; text-align: center; }
.older { margin: 8px 0 0; font-size: 12px; text-align: center; }
button.more { display: block; width: 100%; margin-top: 8px; padding: 5px 8px; font-size: 12px; color: var(--ib-fg2); }
.inbox-error { margin: 0 0 6px; color: var(--ib-danger-text); font-size: 12px; overflow-wrap: anywhere; }
.undo {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--ib-tip-bg);
  color: var(--ib-tip-fg);
  font-size: 12px;
}
.undo button.link { color: var(--ib-tip-fg); margin-left: auto; }

/* A checkbox in a gutter before each thread: shown on hover, on focus and while anything is selected. */
.thread-gutter { flex: none; display: flex; justify-content: center; width: 18px; }
.thread-check { width: 14px; height: 14px; margin: 0; accent-color: var(--ib-accent); cursor: pointer; }
.thread .thread-check { opacity: 0; transition: opacity 100ms ease; }
.thread:hover .thread-check, .thread .thread-check:focus-visible, .thread .thread-check:checked,
.inbox[data-selecting] .thread .thread-check { opacity: 1; }
.thread { display: flex; align-items: flex-start; gap: 4px; }
.thread .thread-gutter { padding-top: 11px; }
.thread details { flex: 1; min-width: 0; }
.threads[data-dragging] { user-select: none; }
.thread[data-selected] details { border-color: var(--ib-accent); background: color-mix(in srgb, var(--ib-accent-soft) 55%, var(--ib-surface)); }

.icon.action { min-height: 26px; padding: 2px 8px; gap: 5px; font-size: 12px; color: var(--ib-fg2); }
.icon.action .glyph { width: 14px; height: 14px; }
.icon.action:hover:not(:disabled) { color: var(--ib-fg); }
.icon.action.danger { color: var(--ib-danger-text); }
.bulk-actions .icon { min-height: 28px; padding: 4px 7px; }
.thread-actions { display: flex; flex-wrap: wrap; gap: 2px; margin: 2px -4px 0; padding-top: 6px; border-top: 1px solid var(--ib-border); }

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
.thread-body { padding: 0 10px 8px; display: grid; gap: 8px; }
.thread-content { display: grid; gap: 6px; }
.thread-meta { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.replies { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.reply { margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--ib-bg); border: 1px solid var(--ib-border); min-width: 0; }
.reply[data-author="agent"] { border-left: 3px solid var(--ib-accent); }
.reply-author { display: block; font-size: 11px; font-weight: 500; color: var(--ib-muted); }
.reply-text { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.badge {
  flex: none;
  font-size: 11px;
  font-weight: 500;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--ib-border);
  color: var(--ib-fg);
}
.badge[data-status="working"] { background: var(--ib-warn); color: var(--ib-warn-fg); }
.badge[data-status="needs-info"] { background: var(--ib-danger); color: var(--ib-on-status); }
.badge[data-status="done"], .badge[data-status="resolved"] { background: var(--ib-success); color: var(--ib-on-status); }
.badge[data-status="archived"] { background: var(--ib-hover); color: var(--ib-muted); }

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
  background: var(--ib-warn);
  color: var(--ib-warn-fg);
  font-size: 11px;
  font-weight: 500;
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

/* A text button that reads as a link. */
button.link {
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent !important;
  color: var(--ib-link);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.agent-hint { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--ib-border); font-size: 12px; }

/* "Use with your agent". */
.agent-intro { margin: 0 0 10px; font-size: 12px; }
.agent-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 10px; }
.agent-tabs [aria-selected="true"] { background: var(--ib-accent-soft); border-color: transparent; color: var(--ib-fg); font-weight: 500; }
.agent-body { display: grid; gap: 12px; }
.agent-step { display: grid; gap: 4px; }
.agent-step-title { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; font-weight: 500; }
.agent-step-number {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ib-hover);
  color: var(--ib-fg2);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.agent-caption { margin: 0; font-size: 12px; }
.agent-manual { display: grid; gap: 4px; padding-top: 10px; border-top: 1px solid var(--ib-border); }
.agent-manual summary { cursor: pointer; font-size: 12px; font-weight: 500; color: var(--ib-fg2); margin-bottom: 2px; }
.snippet {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 6px 6px 10px;
  border: 1px solid var(--ib-border);
  border-radius: 8px;
  background: var(--ib-surface);
}
.snippet-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 2px 0;
  font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ib-fg);
}
.snippet[data-kind="prompt"] .snippet-text { font-family: inherit; font-size: 12px; }
.copy {
  flex: none;
  min-height: 24px;
  padding: 2px 8px;
  border: 1px solid var(--ib-border);
  background: var(--ib-bg);
  font-size: 11px;
  font-weight: 500;
}
/* The copy command's text area (only where the Clipboard API is missing), out of sight inside the shadow root. */
.copy-buffer { position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.copy[data-copied] { color: var(--ib-success-text); border-color: var(--ib-success); }

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
.composer-error { margin: 0; color: var(--ib-danger-text); overflow-wrap: anywhere; }
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
  border: 2px dashed hsl(239 55% 58%);
  border-radius: 2px;
  background: hsl(239 55% 58% / 0.08);
  pointer-events: none;
}
.pick-box.picked { border-style: solid; background: hsl(239 55% 58% / 0.14); }
.pick-box.marked { border: 2px solid rgb(176 112 30); background: rgb(176 112 30 / 0.12); }
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
