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
 * by id, so an item's place never changes once it is shown; the rest are remembered by id and timestamps only, except
 * that the latest copies of at most `limit` hidden threads that events delivered or pushed out of view are kept
 * aside, so a listing that brings such a thread into view shows what the event delivered. Memory and the work per
 * event are bounded by `limit`, however much feedback the daemon has accumulated, and the total stays exact.
 */
export class ThreadsState {
  readonly #limit: number;
  #known = new Map<string, Known>();
  /** The kept items, newest first. */
  #shown: Feedback[] = [];
  #shownById = new Map<string, Feedback>();
  /** Full copies of hidden threads that events delivered or pushed out of view, oldest first; at most `limit`. */
  #aside = new Map<string, Feedback>();

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
    if (known) known.updatedAt = updatedAt;
    else this.#known.set(item.id, { createdAt: time(item.createdAt), updatedAt });
    const held = this.#shownById.get(item.id);
    if (!held) {
      // A hidden thread fills a gap in the window (left by a listing that omitted shown threads) or is kept aside.
      this.#setAside(this.#insert(this.#shown, this.#shownById, item, this.#known));
      if (this.#shownById.has(item.id)) {
        this.#aside.delete(item.id);
        return "changed";
      }
      this.#setAside(item);
      return known ? "unchanged" : "changed";
    }
    if (sameFeedback(held, item)) return "unchanged";
    this.#shown[this.#shown.indexOf(held)] = item;
    this.#shownById.set(item.id, item);
    return "changed";
  }

  /**
   * Applies a complete listing from the daemon, which replaces what is held. An item it omits is dropped unless an
   * event that was not stale delivered it while the listing was in flight (`touched`). The listing may predate such an
   * event even with an equal `updatedAt`, so for a touched item the held copy also wins a tie; a strictly newer listed
   * copy still wins. A held copy that wins but is not shown takes its content from the copies kept aside; failing that,
   * the listed copy is taken whole, and an omitted touched thread without content is kept only while it is hidden.
   * Returns whether anything shown or counted changed.
   */
  applyListing(listed: readonly Feedback[], touched: ReadonlySet<string>): boolean {
    const known = new Map<string, Known>();
    const shown: Feedback[] = [];
    const shownById = new Map<string, Feedback>();
    const keptCopies: Feedback[] = [];
    for (const item of listed) {
      if (known.has(item.id)) continue;
      const held = this.#known.get(item.id);
      const listedAt = time(item.updatedAt);
      const heldWins = held !== undefined && (held.updatedAt > listedAt || (touched.has(item.id) && held.updatedAt === listedAt));
      // A winning held copy whose content is no longer kept gives way entirely, so content and timestamp agree.
      const kept = heldWins ? this.#heldCopy(item.id) : undefined;
      known.set(item.id, { createdAt: time(item.createdAt), updatedAt: kept ? held!.updatedAt : listedAt });
      this.#insert(shown, shownById, kept ?? item, known);
      if (kept) keptCopies.push(kept);
    }
    this.#keepOmittedTouched(touched, known, shown, shownById, keptCopies);
    const changed = known.size !== this.#known.size || shown.length !== this.#shown.length
      || shown.some((item, index) => !sameFeedback(item, this.#shown[index]!));
    this.#known = known;
    this.#shown = shown;
    this.#shownById = shownById;
    // Held copies that won but stay hidden keep their content for a later listing.
    this.#aside = new Map(keptCopies.filter((item) => !shownById.has(item.id)).slice(-this.#limit).map((item) => [item.id, item]));
    return changed;
  }

  /** Forgets every thread. Returns whether there was any. */
  clear(): boolean {
    const changed = this.#known.size > 0;
    this.#known = new Map();
    this.#shown = [];
    this.#shownById = new Map();
    this.#aside = new Map();
    return changed;
  }

  /** Keeps the touched threads a listing omits in the listing's new `known`, `shown` and `shownById`. */
  #keepOmittedTouched(touched: ReadonlySet<string>, known: Map<string, Known>, shown: Feedback[],
    shownById: Map<string, Feedback>, keptCopies: Feedback[]): void {
    const contentless: string[] = [];
    for (const id of touched) {
      const held = this.#known.get(id);
      if (!held || known.has(id)) continue;
      known.set(id, { ...held });
      const kept = this.#heldCopy(id);
      if (kept) {
        keptCopies.push(kept);
        this.#insert(shown, shownById, kept, known);
      } else {
        contentless.push(id);
      }
    }
    // Counting a thread that would be shown but whose content is unknown would leave a row missing.
    for (const id of contentless) if (this.#position(shown, id, known) < this.#limit) known.delete(id);
  }

  /** The full copy held for a thread, shown or kept aside. */
  #heldCopy(id: string): Feedback | undefined {
    return this.#shownById.get(id) ?? this.#aside.get(id);
  }

  /** Keeps an event copy of a hidden thread aside, dropping the oldest delivery beyond `limit`. */
  #setAside(item: Feedback | undefined): void {
    if (!item) return;
    this.#aside.delete(item.id);
    this.#aside.set(item.id, item);
    if (this.#aside.size > this.#limit) this.#aside.delete(this.#aside.keys().next().value!);
  }

  /** Where the thread `id` belongs in `shown` (newest first) by binary search. `known` holds every creation time. */
  #position(shown: readonly Feedback[], id: string, known: ReadonlyMap<string, Known>): number {
    const createdAt = known.get(id)!.createdAt;
    let low = 0;
    let high = shown.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = shown[middle]!;
      if ((createdAt - known.get(other.id)!.createdAt || compareIds(other.id, id)) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /**
   * Inserts `item` into `shown` when it is among the newest `limit`, evicting the oldest beyond it. Returns the evicted
   * item, if any.
   */
  #insert(shown: Feedback[], shownById: Map<string, Feedback>, item: Feedback, known: ReadonlyMap<string, Known>): Feedback | undefined {
    const at = this.#position(shown, item.id, known);
    if (at >= this.#limit) return undefined;
    shown.splice(at, 0, item);
    shownById.set(item.id, item);
    if (shown.length <= this.#limit) return undefined;
    const evicted = shown.pop()!;
    shownById.delete(evicted.id);
    return evicted;
  }
}
