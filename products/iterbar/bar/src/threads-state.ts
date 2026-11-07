import type { Feedback } from "iterbar";

/** What the bar remembers about every thread it knows of, shown or not: enough to count it and to judge staleness. */
interface Known {
  readonly createdAt: number;
  updatedAt: number;
}

/** How an event's copy of an item compared with what was held. */
export type MergeResult = "stale" | "unchanged" | "changed";

const time = (value: string): number => Date.parse(value);

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const sameFeedback = (left: Feedback, right: Feedback): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * The feedback threads the bar knows about. Only the newest `limit` by creation are kept in full, newest first, ties
 * by id, so an item's place never changes once it is shown; the rest are remembered by id and timestamps only. Memory
 * and the work per event are bounded by `limit`, however much feedback the daemon has accumulated, and the total
 * stays exact.
 */
export class ThreadsState {
  readonly #limit: number;
  #known = new Map<string, Known>();
  /** The kept items, newest first. */
  #shown: Feedback[] = [];
  #shownById = new Map<string, Feedback>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Every thread known, shown or not. */
  get total(): number {
    return this.#known.size;
  }

  /** The kept threads, newest first. */
  shown(): readonly Feedback[] {
    return this.#shown;
  }

  /** The kept copy of a thread; `undefined` for one that is not shown. */
  get(id: string): Feedback | undefined {
    return this.#shownById.get(id);
  }

  /**
   * Applies an item from an event. A listing and an event can arrive in either order, so an older copy
   * (`updatedAt`) than the one held is `stale` and dropped; a copy as recent replaces the held one. Only a copy that is
   * not stale may take precedence over a listing in flight (see {@link applyListing}).
   */
  merge(item: Feedback): MergeResult {
    const known = this.#known.get(item.id);
    const updatedAt = time(item.updatedAt);
    if (known && known.updatedAt > updatedAt) return "stale";
    if (!known) {
      this.#known.set(item.id, { createdAt: time(item.createdAt), updatedAt });
      this.#shown = this.#insert(this.#shown, this.#shownById, item, this.#known);
      return "changed";
    }
    known.updatedAt = updatedAt;
    const held = this.#shownById.get(item.id);
    if (!held || sameFeedback(held, item)) return "unchanged";
    this.#shown[this.#shown.indexOf(held)] = item;
    this.#shownById.set(item.id, item);
    return "changed";
  }

  /**
   * Applies a complete listing from the daemon, which replaces what is held. An item it omits is dropped unless an
   * event that was not stale delivered it while the listing was in flight (`touched`). The listing may predate such an
   * event even with an equal `updatedAt`, so for a touched item the held copy also wins a tie; a strictly newer listed
   * copy still wins. A held copy that wins but is not shown has only its timestamps kept, so the listed copy stands in
   * for its content. Returns whether anything shown or counted changed.
   */
  applyListing(listed: readonly Feedback[], touched: ReadonlySet<string>): boolean {
    const known = new Map<string, Known>();
    let shown: Feedback[] = [];
    const shownById = new Map<string, Feedback>();
    for (const item of listed) {
      if (known.has(item.id)) continue;
      const held = this.#known.get(item.id);
      const listedAt = time(item.updatedAt);
      const keepHeld = held !== undefined && (held.updatedAt > listedAt || (touched.has(item.id) && held.updatedAt === listedAt));
      known.set(item.id, { createdAt: time(item.createdAt), updatedAt: keepHeld ? held.updatedAt : listedAt });
      shown = this.#insert(shown, shownById, keepHeld ? this.#shownById.get(item.id) ?? item : item, known);
    }
    for (const id of touched) {
      const held = this.#known.get(id);
      if (!held || known.has(id)) continue;
      known.set(id, { ...held });
      const kept = this.#shownById.get(id);
      if (kept) shown = this.#insert(shown, shownById, kept, known);
    }
    const changed = known.size !== this.#known.size || shown.length !== this.#shown.length
      || shown.some((item, index) => !sameFeedback(item, this.#shown[index]!));
    this.#known = known;
    this.#shown = shown;
    this.#shownById = shownById;
    return changed;
  }

  /** Forgets every thread. Returns whether there was any. */
  clear(): boolean {
    const changed = this.#known.size > 0;
    this.#known = new Map();
    this.#shown = [];
    this.#shownById = new Map();
    return changed;
  }

  /**
   * Inserts `item` into `shown` (newest first) by binary search when it is among the newest `limit`, evicting the
   * oldest beyond it. `known` holds every item's creation time. Returns the (possibly same) array.
   */
  #insert(shown: Feedback[], shownById: Map<string, Feedback>, item: Feedback, known: ReadonlyMap<string, Known>): Feedback[] {
    const createdAt = known.get(item.id)!.createdAt;
    let low = 0;
    let high = shown.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = shown[middle]!;
      if ((createdAt - known.get(other.id)!.createdAt || compareIds(other.id, item.id)) < 0) low = middle + 1;
      else high = middle;
    }
    if (low >= this.#limit) return shown;
    shown.splice(low, 0, item);
    shownById.set(item.id, item);
    if (shown.length > this.#limit) shownById.delete(shown.pop()!.id);
    return shown;
  }
}
