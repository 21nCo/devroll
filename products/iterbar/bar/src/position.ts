/** Local storage key, per origin, holding where the toolbar sits, whether it is pinned open and which panel is open. */
export const BAR_STATE_STORAGE_KEY = "iterbar:toolbar";

/** Where along the bottom edge the toolbar is docked. */
export type Dock = "left" | "center" | "right";

export const DOCKS: readonly Dock[] = ["left", "center", "right"];

/** The panel that opens upward from the toolbar. */
export type PanelName = "inbox" | "drafts" | "versions";

export const PANELS: readonly PanelName[] = ["inbox", "drafts", "versions"];

/** Which threads the inbox lists. */
export type InboxFilter = "all" | "open" | "progress" | "done";

export const INBOX_FILTERS: readonly InboxFilter[] = ["all", "open", "progress", "done"];

export interface BarState {
  readonly dock: Dock;
  /**
   * Whether the full toolbar stays shown. When `false` the toolbar sleeps: a compact pill that wakes while the pointer
   * or focus is on it, a panel is open or comment mode is on.
   */
  readonly expanded: boolean;
  /** The open panel, or `null`. */
  readonly panel: PanelName | null;
  readonly filter: InboxFilter;
}

/** Gap, in CSS pixels, the toolbar keeps from the screen edges; the stylesheet's `--ib-margin`. */
export const BAR_MARGIN_PX = 12;

/** Bottom centre, sleeping, no panel, every thread. */
export const DEFAULT_BAR_STATE: BarState = Object.freeze({ dock: "center", expanded: false, panel: null, filter: "all" });

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

/** Reads a stored state; anything malformed falls back field by field to {@link DEFAULT_BAR_STATE}. Never throws. */
export function parseBarState(text: string | null | undefined): BarState {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "null");
  } catch {
    return DEFAULT_BAR_STATE;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_BAR_STATE;
  const { dock, expanded, panel, filter } = value as Record<string, unknown>;
  return {
    dock: oneOf(DOCKS, dock, DEFAULT_BAR_STATE.dock),
    expanded: typeof expanded === "boolean" ? expanded : DEFAULT_BAR_STATE.expanded,
    panel: PANELS.includes(panel as PanelName) ? panel as PanelName : null,
    filter: oneOf(INBOX_FILTERS, filter, DEFAULT_BAR_STATE.filter),
  };
}

export function formatBarState(state: BarState): string {
  return JSON.stringify({ dock: state.dock, expanded: state.expanded, panel: state.panel, filter: state.filter });
}

/** The next dock in left, centre, right order, wrapping round. */
export function nextDock(dock: Dock): Dock {
  return DOCKS[(DOCKS.indexOf(dock) + 1) % DOCKS.length]!;
}

/** The dock an arrow key moves the toolbar to from `dock`, or `null` for any other key or at the end of the edge. */
export function dockForKey(dock: Dock, key: string): Dock | null {
  const index = DOCKS.indexOf(dock);
  if (key === "ArrowLeft") return index > 0 ? DOCKS[index - 1]! : null;
  if (key === "ArrowRight") return index < DOCKS.length - 1 ? DOCKS[index + 1]! : null;
  return null;
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
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  const left = Math.min(maxLeft, Math.max(margin, target.left));
  return { left: Math.round(left), top: Math.round(top) };
}
