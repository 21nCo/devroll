import { AGENTS, type AgentName } from "./agent-help.js";

/**
 * Local storage key, per origin, holding where the toolbar sits, whether it is pinned open and which panel is open. A
 * bar given a project (see {@link barStateStorageKey}) keeps its state under this key plus the project.
 */
export const BAR_STATE_STORAGE_KEY = "iterbar:toolbar";

/** The storage key for a project's toolbar state: one per project on an origin, so each project keeps its place. */
export function barStateStorageKey(project: string | null | undefined): string {
  return project ? `${BAR_STATE_STORAGE_KEY}:${project}` : BAR_STATE_STORAGE_KEY;
}

/** The panel that opens upward from the toolbar. */
export type PanelName = "inbox" | "drafts" | "variants" | "agent";

export const PANELS: readonly PanelName[] = ["inbox", "drafts", "variants", "agent"];

/** Panel names stored by earlier bars, read as the panel they became. */
const LEGACY_PANELS: Readonly<Record<string, PanelName>> = { versions: "variants" };

/** Which threads the inbox lists. "all" leaves out archived threads, which only "archived" lists. */
export type InboxFilter = "all" | "open" | "progress" | "done" | "archived";

export const INBOX_FILTERS: readonly InboxFilter[] = ["all", "open", "progress", "done", "archived"];

export interface BarState {
  /**
   * Where along the bottom edge the logo sits: 0 at the left margin, 1 at the right margin, 0.5 centred. It is a share
   * of the room the logo has, so it stays inside the viewport at any width; the expanded toolbar grows away from it.
   */
  readonly x: number;
  /**
   * Whether the full toolbar shows. When `false` it is collapsed to the Iterbar logo, which expands it when clicked;
   * a panel, the composer or comment mode still show the full toolbar while they last.
   */
  readonly expanded: boolean;
  /** The open panel, or `null`. */
  readonly panel: PanelName | null;
  readonly filter: InboxFilter;
  /** The agent "Use with your agent" shows the steps for. */
  readonly agent: AgentName;
}

/** Gap, in CSS pixels, the toolbar keeps from the left and right screen edges; the stylesheet's `--ib-margin`. */
export const BAR_MARGIN_PX = 12;

/** Gap, in CSS pixels, below the toolbar; the stylesheet's `--ib-bottom`. */
export const BAR_BOTTOM_PX = 20;

/** Bottom centre, collapsed, no panel, every thread. */
export const DEFAULT_BAR_STATE: BarState = Object.freeze({ x: 0.5, expanded: false, panel: null, filter: "all", agent: "claude" });

/** The positions the earlier left, centre and right docks stood for; a stored dock still places the toolbar. */
const LEGACY_DOCKS: Readonly<Record<string, number>> = { left: 0, center: 0.5, right: 1 };

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

/** `value` kept within 0 and 1; anything that is not a finite number is `null`. */
export function clampPosition(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** Reads a stored state; anything malformed falls back field by field to {@link DEFAULT_BAR_STATE}. Never throws. */
export function parseBarState(text: string | null | undefined): BarState {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "null");
  } catch {
    return DEFAULT_BAR_STATE;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_BAR_STATE;
  const { x, dock, expanded, panel, filter, agent } = value as Record<string, unknown>;
  const legacy = typeof dock === "string" && Object.hasOwn(LEGACY_DOCKS, dock) ? LEGACY_DOCKS[dock]! : null;
  return {
    x: clampPosition(x) ?? legacy ?? DEFAULT_BAR_STATE.x,
    expanded: typeof expanded === "boolean" ? expanded : DEFAULT_BAR_STATE.expanded,
    panel: PANELS.includes(panel as PanelName) ? panel as PanelName
      : typeof panel === "string" && Object.hasOwn(LEGACY_PANELS, panel) ? LEGACY_PANELS[panel]! : null,
    filter: oneOf(INBOX_FILTERS, filter, DEFAULT_BAR_STATE.filter),
    agent: oneOf(AGENTS, agent, DEFAULT_BAR_STATE.agent),
  };
}

export function formatBarState(state: BarState): string {
  return JSON.stringify({ x: state.x, expanded: state.expanded, panel: state.panel, filter: state.filter, agent: state.agent });
}

/**
 * The left edge, in viewport pixels, of a `width`-wide toolbar at position `x` in a `viewport`-wide view: `x` shares
 * out the room between the margins. A toolbar wider than that room sits at the left margin.
 */
export function leftForPosition(x: number, width: number, viewport: number, margin = BAR_MARGIN_PX): number {
  const room = Math.max(0, viewport - 2 * margin - width);
  return margin + room * (clampPosition(x) ?? DEFAULT_BAR_STATE.x);
}

/**
 * The left edge of a `width`-wide toolbar whose logo (`logoWidth` wide, at the toolbar's start, or at its end when it
 * runs right to left) sits at position `x`: the logo stays where it is when the toolbar expands, and the rest grows
 * away from it, kept inside the margins.
 */
export function toolbarLeft(x: number, logoWidth: number, width: number, viewport: number, end: boolean, margin = BAR_MARGIN_PX): number {
  const logo = leftForPosition(x, logoWidth, viewport, margin);
  const wanted = end ? logo + logoWidth - width : logo;
  const max = Math.max(margin, viewport - margin - width);
  return Math.min(max, Math.max(margin, wanted));
}

/**
 * The left edge of a `panelWidth`-wide panel above a toolbar at `left`, `width` wide: lined up with the toolbar's start
 * (its end when it runs right to left), kept inside the margins.
 */
export function panelLeft(left: number, width: number, panelWidth: number, viewport: number, end: boolean, margin = BAR_MARGIN_PX): number {
  const wanted = end ? left + width - panelWidth : left;
  const max = Math.max(margin, viewport - margin - panelWidth);
  return Math.min(max, Math.max(margin, wanted));
}

/**
 * The inverse of {@link leftForPosition}: the position of a toolbar whose left edge is at `left`, kept within 0 and 1
 * and rounded to thousandths, as it is stored, so a drag shows exactly what dropping it saves.
 */
export function positionForLeft(left: number, width: number, viewport: number, margin = BAR_MARGIN_PX): number {
  const room = viewport - 2 * margin - width;
  if (room <= 0) return DEFAULT_BAR_STATE.x;
  return Math.round((clampPosition((left - margin) / room) ?? DEFAULT_BAR_STATE.x) * 1000) / 1000;
}

/** Arrow keys on the logo move the toolbar by this share of its room; with Shift, by the larger step. */
export const POSITION_STEP = 0.05;
export const POSITION_STEP_LARGE = 0.25;

/** The position a key on the logo moves the toolbar to from `x`, or `null` for a key that does not move it. */
export function positionForKey(x: number, key: string, shift: boolean): number | null {
  const step = shift ? POSITION_STEP_LARGE : POSITION_STEP;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  switch (key) {
    case "ArrowLeft": return round(Math.max(0, x - step));
    case "ArrowRight": return round(Math.min(1, x + step));
    case "Home": return 0;
    case "End": return 1;
    default: return null;
  }
}

/** How a position reads aloud: left, centre, right, or a percentage between. */
export function describePosition(x: number): string {
  if (x <= 0) return "left";
  if (x >= 1) return "right";
  if (Math.abs(x - 0.5) < 0.005) return "centre";
  return `${Math.round(x * 100)}% from the left`;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Room the comment popover keeps from the element it is anchored to. */
const ANCHOR_GAP_PX = 8;

/**
 * Where to put a `size` popover anchored to `target` in a `viewport`: below the target when it fits there, else above
 * it, else wherever along the viewport's height it fits best; left-aligned with the target, kept inside the margins.
 * `reserved` is the height at the bottom of the viewport the toolbar takes, which the popover avoids when it can.
 */
export function anchorPopover(
  target: Rect,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  reserved = 0,
): { left: number; top: number } {
  const margin = BAR_MARGIN_PX;
  const bottomLimit = viewport.height - Math.max(margin, reserved);
  const below = target.top + target.height + ANCHOR_GAP_PX;
  const above = target.top - ANCHOR_GAP_PX - size.height;
  let top: number;
  if (below + size.height <= bottomLimit) top = below;
  else if (above >= margin) top = above;
  else top = Math.max(margin, Math.min(bottomLimit - size.height, below));
  // An element scrolled out of view still leaves the popover inside the viewport.
  top = Math.max(margin, Math.min(top, bottomLimit - size.height));
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  const left = Math.min(maxLeft, Math.max(margin, target.left));
  return { left: Math.round(left), top: Math.round(top) };
}
