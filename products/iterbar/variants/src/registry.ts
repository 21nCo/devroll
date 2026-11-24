import {
  formatVariantParam,
  InvalidMessageError,
  PAGE_API_GLOBAL,
  parseMessage,
  parseVariantParam,
  SCHEMA_VERSION,
  slotStateSchema,
  VARIANT_STORAGE_KEY,
  LEGACY_SCHEMA_VERSION,
  upgradeMessage,
  variantSelectionSchema,
  type ActiveVariant,
  type IterbarPageApi,
  type ParsedVariantParam,
  type RegistrySnapshot,
  type RegistryWarning,
} from "@iterbar/core";
import {
  browserEnvironment,
  readVariantParam,
  withVariantParam,
  type VariantsEnvironment,
} from "./environment.js";

/** Most slots one page may register, matching the snapshot contract. */
export const MAX_SLOTS = 256;

/** Most warnings a snapshot carries, matching the snapshot contract. */
const MAX_WARNINGS = 256;

/** Rejected `select()` calls the registry remembers; older ones are dropped first. */
const MAX_API_WARNINGS = 32;

/**
 * Drops the earliest selections other than `slot`'s until at most {@link MAX_SLOTS} remain, the most a URL
 * parameter or stored value may hold. Local storage is shared by every page of the origin, so it can
 * collect selections for more slots than one page mounts; the newest choice must still be saved.
 */
function withinSelectionLimit(selections: readonly ActiveVariant[], slot: string): ActiveVariant[] {
  let excess = selections.length - MAX_SLOTS;
  return selections.filter((entry) => {
    if (excess <= 0 || entry.slot === slot) return true;
    excess -= 1;
    return false;
  });
}

/** One slot as a component declares it. */
export interface SlotDefinition {
  readonly slot: string;
  /** Variant names in display order; unique, 1-64 of them. */
  readonly variants: readonly string[];
  readonly defaultVariant: string;
}

interface SlotInstance {
  readonly definition: SlotDefinition;
}

interface SlotRecord {
  /** One entry per mounted instance, earliest first. The earliest one's definition defines the slot. */
  readonly instances: SlotInstance[];
  activeVariant: string;
  /** Whether `select()` chose the active variant in this page, as opposed to the URL, storage or default. */
  selectedInPage: boolean;
  /** Why the active variant is the default even though the URL or storage named another one. */
  warnings: RegistryWarning[];
}

type SelectionSource = "url" | "storage";

export interface VariantsRegistryOptions {
  /** Where selections are read from and remembered. Defaults to the global `location`, `history` and `localStorage`. */
  readonly environment?: VariantsEnvironment;
}

/**
 * Throws `invalid_message` unless `definition` names a valid slot with 1-64 unique valid variants that
 * include the default. Returns a copy that later changes to the caller's arrays cannot affect.
 */
export function validateSlotDefinition(definition: SlotDefinition): SlotDefinition {
  // A copy of this package from protocol version 1 sharing the page's registry declares `versions` and
  // `defaultVersion`; they are read as the variants and the default.
  const legacy = definition as Partial<SlotDefinition> & { versions?: unknown; defaultVersion?: unknown };
  const state = parseMessage(slotStateSchema, {
    slot: definition?.slot,
    variants: legacy?.variants ?? legacy?.versions,
    defaultVariant: legacy?.defaultVariant ?? legacy?.defaultVersion,
    activeVariant: legacy?.defaultVariant ?? legacy?.defaultVersion,
    mounts: 1,
  }, "slot definition");
  return Object.freeze({
    slot: state.slot,
    variants: Object.freeze([...state.variants]),
    defaultVariant: state.defaultVariant,
  });
}

function sameDefinition(left: SlotDefinition, right: SlotDefinition): boolean {
  return left.defaultVariant === right.defaultVariant
    && left.variants.length === right.variants.length
    && left.variants.every((variant, index) => right.variants[index] === variant);
}

function definitionOf(record: SlotRecord): SlotDefinition {
  return record.instances[0]!.definition;
}

function warning(
  code: RegistryWarning["code"],
  source: RegistryWarning["source"],
  value: string,
  message: string,
): RegistryWarning {
  return { code, source, value: value.slice(0, 1024), message };
}

const SOURCE_LABEL: Record<RegistryWarning["source"], string> = {
  url: "the iterbar URL parameter",
  storage: "stored selections",
  api: "select()",
};

function describe(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function reportListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(error);
}

/**
 * The slots rendered on one page and the variant each one shows. A slot's variant is chosen when its first
 * instance registers: the `iterbar` URL parameter wins, then the stored selection, then the default. A URL
 * or stored variant the slot does not have falls back to the default and is reported as a warning.
 */
export class VariantsRegistry {
  readonly #environment: VariantsEnvironment;
  readonly #slots = new Map<string, SlotRecord>();
  readonly #listeners = new Set<() => void>();
  #apiWarnings: RegistryWarning[] = [];

  /** The `window.__ITERBAR__` object for this registry; see {@link installPageApi}. */
  readonly pageApi: IterbarPageApi;

  constructor(options: VariantsRegistryOptions = {}) {
    this.#environment = options.environment ?? browserEnvironment();
    const pageApi: IterbarPageApi = {
      schemaVersion: SCHEMA_VERSION,
      getSnapshot: () => this.getSnapshot(),
      select: (selection) => this.select(selection),
      subscribe: (listener) => {
        if (typeof listener !== "function") throw new TypeError("subscribe(listener) needs a function");
        return this.subscribe(() => listener(this.getSnapshot()));
      },
    };
    this.pageApi = Object.freeze(pageApi);
  }

  /**
   * Counts one mounted instance of `definition.slot` and returns its idempotent unregister function. The
   * earliest mounted instance decides the slot's variants and default; a later instance that declares
   * different ones is logged and shares that state. When the earliest instance unregisters, the next one's
   * definition applies, so a slot whose instances all re-register with new variants (for example after a hot
   * update) ends up with the new variants. Throws `invalid_message` for an invalid definition or when the
   * page already has {@link MAX_SLOTS} slots.
   */
  register(definition: SlotDefinition): () => void {
    const valid = validateSlotDefinition(definition);
    const instance: SlotInstance = { definition: valid };
    let record = this.#slots.get(valid.slot);
    if (record) {
      record.instances.push(instance);
      if (!sameDefinition(definitionOf(record), valid)) {
        console.warn(
          `Iterbar slot "${valid.slot}" is mounted with different variants or default; `
          + "every instance follows the earliest mounted one's selection.",
        );
      }
    } else {
      if (this.#slots.size >= MAX_SLOTS) {
        throw new InvalidMessageError("slot definition", [`a page may register at most ${MAX_SLOTS} slots`]);
      }
      const resolved = this.#resolve(valid);
      record = {
        instances: [instance], activeVariant: resolved.variant, selectedInPage: false, warnings: resolved.warnings,
      };
      this.#slots.set(valid.slot, record);
    }
    this.#notify();

    const registered = record;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = registered.instances.indexOf(instance);
      if (this.#slots.get(valid.slot) !== registered || index === -1) return;
      const previous = definitionOf(registered);
      registered.instances.splice(index, 1);
      if (registered.instances.length === 0) this.#slots.delete(valid.slot);
      else this.#refreshDefinition(registered, previous);
      this.#notify();
    };
  }

  /**
   * The variant an instance declaring `definition` should render now, without registering it: the slot's
   * active variant when it is registered and `definition` has that variant, its own default when it does
   * not, and otherwise what registering would choose.
   */
  activeVariant(definition: SlotDefinition): string {
    // Called on every render, so only a version 1 definition (no `variants`) is read again, under the new names.
    if (!Array.isArray((definition as Partial<SlotDefinition>).variants)) definition = validateSlotDefinition(definition);
    const record = this.#slots.get(definition.slot);
    if (!record) return this.#resolve(definition).variant;
    return definition.variants.includes(record.activeVariant) ? record.activeVariant : definition.defaultVariant;
  }

  /**
   * {@link activeVariant} under its protocol version 1 name, for a copy of this package from that version that shares
   * the page's registry (it declares `versions` and `defaultVersion`).
   * @deprecated Use {@link activeVariant}.
   */
  activeVersion(definition: SlotDefinition): string {
    return this.activeVariant(definition);
  }

  /**
   * After the defining instance unregisters, keeps a variant chosen with `select()` while the next definition
   * has it, even if remembering it failed. Otherwise the slot chooses again as a first registration would:
   * the URL, then storage (an unknown variant there shows the default and is reported), then the default.
   */
  #refreshDefinition(record: SlotRecord, previous: SlotDefinition): void {
    const definition = definitionOf(record);
    if (sameDefinition(definition, previous)) return;
    if (record.selectedInPage && definition.variants.includes(record.activeVariant)) return;
    const resolved = this.#resolve(definition);
    record.activeVariant = resolved.variant;
    record.selectedInPage = false;
    record.warnings = resolved.warnings;
  }

  /**
   * Switches a registered slot to one of its variants and remembers the choice in local storage and, when
   * the URL already names the slot, in the URL. Unknown slots or variants and malformed selections are
   * recorded as `source: "api"` warnings and leave every slot unchanged. Never throws.
   */
  select(selection: unknown): void {
    // A bar from the previous protocol version selects with `{ schemaVersion: 1, slot, version }`.
    const parsed = variantSelectionSchema.safeParse(upgradeMessage(selection));
    if (!parsed.success) {
      this.#rejectSelection(warning(
        "invalid_selection", "api", describe(selection),
        "select() needs { schemaVersion: 2, slot, variant } with valid names.",
      ));
      return;
    }
    const { slot, variant } = parsed.data;
    const record = this.#slots.get(slot);
    if (!record) {
      this.#rejectSelection(warning("unknown_slot", "api", `${slot}:${variant}`, `No slot named "${slot}" is mounted.`));
      return;
    }
    const definition = definitionOf(record);
    if (!definition.variants.includes(variant)) {
      this.#rejectSelection(warning(
        "unknown_variant", "api", `${slot}:${variant}`, `Slot "${slot}" has no variant "${variant}".`,
      ));
      return;
    }
    // Remembering the choice can also drop malformed URL or stored entries, which changes the warnings; so
    // compare whole snapshots rather than only the slot's own state.
    const before = JSON.stringify(this.getSnapshot());
    this.#remember(definition, variant);
    record.activeVariant = variant;
    record.selectedInPage = true;
    record.warnings = [];
    if (JSON.stringify(this.getSnapshot()) !== before) this.#notify();
  }

  /** Calls `listener` after every change to slots, selections or warnings; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    const entry = () => listener();
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  /** A new snapshot of the mounted slots and of every selection the registry could not honour. */
  getSnapshot(): RegistrySnapshot {
    const warnings: RegistryWarning[] = [];
    const url = this.#read("url");
    for (const entry of url.invalid) {
      warnings.push(warning("invalid_selection", "url", entry, "Ignored a malformed entry in the iterbar URL parameter."));
    }
    for (const { slot, variant } of url.selections) {
      if (!this.#slots.has(slot)) {
        warnings.push(warning("unknown_slot", "url", `${slot}:${variant}`, `No slot named "${slot}" is mounted.`));
      }
    }
    for (const record of this.#slots.values()) warnings.push(...record.warnings);
    for (const entry of this.#read("storage").invalid) {
      warnings.push(warning("invalid_selection", "storage", entry, "Ignored a malformed stored selection."));
    }
    warnings.push(...this.#apiWarnings);
    return {
      schemaVersion: SCHEMA_VERSION,
      slots: [...this.#slots.values()].map((record) => {
        const definition = definitionOf(record);
        return {
          slot: definition.slot,
          variants: [...definition.variants],
          defaultVariant: definition.defaultVariant,
          activeVariant: record.activeVariant,
          mounts: record.instances.length,
        };
      }),
      warnings: warnings.slice(0, MAX_WARNINGS).map((entry) => ({ ...entry })),
    };
  }

  #resolve(definition: SlotDefinition): { variant: string; warnings: RegistryWarning[] } {
    for (const source of ["url", "storage"] as const) {
      const selection = this.#read(source).selections.find((entry) => entry.slot === definition.slot);
      if (!selection) continue;
      if (definition.variants.includes(selection.variant)) return { variant: selection.variant, warnings: [] };
      return {
        variant: definition.defaultVariant,
        warnings: [warning(
          "unknown_variant", source, `${selection.slot}:${selection.variant}`,
          `Slot "${selection.slot}" has no variant "${selection.variant}" (from ${SOURCE_LABEL[source]}); `
          + `showing "${definition.defaultVariant}".`,
        )],
      };
    }
    return { variant: definition.defaultVariant, warnings: [] };
  }

  #read(source: SelectionSource): ParsedVariantParam {
    return parseVariantParam(source === "url" ? this.#readUrlValue() : this.#readStoredValue());
  }

  #readUrlValue(): string | null {
    try {
      return readVariantParam(this.#environment.readSearch());
    } catch {
      return null;
    }
  }

  #readStoredValue(): string | null {
    try {
      return this.#environment.storage()?.getItem(VARIANT_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Stores `variant` (or forgets the slot when it is the default) and rewrites the URL entry for the slot
   * when there is one, so a reload keeps showing the selected variant. Failures are ignored: the switch
   * still applies to this page.
   */
  #remember(definition: SlotDefinition, variant: string): void {
    const { slot } = definition;
    try {
      const storage = this.#environment.storage();
      if (storage) {
        const others = this.#read("storage").selections.filter((entry) => entry.slot !== slot);
        const kept = variant === definition.defaultVariant ? others : [...others, { slot, variant }];
        const stored = formatVariantParam(withinSelectionLimit(kept, slot));
        if (stored) storage.setItem(VARIANT_STORAGE_KEY, stored);
        else storage.removeItem(VARIANT_STORAGE_KEY);
      }
    } catch {
      // Storage may be unavailable or full; the in-page switch does not depend on it.
    }
    try {
      const url = this.#read("url").selections;
      if (this.#environment.replaceSearch && url.some((entry) => entry.slot === slot)) {
        const updated = url.map((entry) => entry.slot === slot ? { ...entry, variant } : entry);
        const value = formatVariantParam(withinSelectionLimit(updated, slot));
        this.#environment.replaceSearch(withVariantParam(this.#environment.readSearch(), value));
      }
    } catch {
      // The URL is best effort too; a router may refuse history changes.
    }
  }

  #rejectSelection(entry: RegistryWarning): void {
    // Once the list is full of identical rejections, another one leaves the snapshot unchanged.
    const before = JSON.stringify(this.getSnapshot());
    this.#apiWarnings = [...this.#apiWarnings, entry].slice(-MAX_API_WARNINGS);
    if (JSON.stringify(this.getSnapshot()) !== before) this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
}

/** Creates a registry that is not installed anywhere; see {@link getVariantsRegistry} for the page's shared one. */
export function createVariantsRegistry(options: VariantsRegistryOptions = {}): VariantsRegistry {
  return new VariantsRegistry(options);
}

/**
 * Sets `target.__ITERBAR__` to the registry's page API. Returns false, and leaves the existing value, when
 * another object already occupies the name.
 */
export function installPageApi(registry: VariantsRegistry, target: object = globalThis): boolean {
  const holder = target as Record<string, unknown>;
  const existing = holder[PAGE_API_GLOBAL];
  if (existing === registry.pageApi) return true;
  if (existing !== undefined) {
    console.warn(`Iterbar: window.${PAGE_API_GLOBAL} is already set; the variants registry did not replace it.`);
    return false;
  }
  Object.defineProperty(holder, PAGE_API_GLOBAL, {
    value: registry.pageApi,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return true;
}

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

/**
 * The page's shared registry, created on first use with the browser environment and installed as
 * `window.__ITERBAR__`. Copies of this package loaded by different bundles share it through a global symbol.
 */
export function getVariantsRegistry(): VariantsRegistry {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[SHARED_REGISTRY];
  if (existing instanceof VariantsRegistry || isRegistryLike(existing)) return existing as VariantsRegistry;
  // A copy of this package from protocol version 1 created the page's registry first: its slots are the ones the bar
  // sees, so this copy registers there too, through an adapter that speaks version 1.
  if (isLegacyRegistry(existing)) return legacyBridge(existing);
  const registry = new VariantsRegistry();
  Object.defineProperty(holder, SHARED_REGISTRY, { value: registry, configurable: true, enumerable: false });
  installPageApi(registry);
  return registry;
}

/** The methods a version 1 registry (from an earlier copy of this package) has. */
interface LegacyRegistry {
  readonly pageApi: IterbarPageApi;
  register(definition: { slot: string; versions: readonly string[]; defaultVersion: string }): () => void;
  activeVersion(definition: { slot: string; versions: readonly string[]; defaultVersion: string }): string;
  subscribe(listener: () => void): () => void;
  select?(selection: unknown): void;
  getSnapshot?(): unknown;
}

function isLegacyRegistry(value: unknown): value is LegacyRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof LegacyRegistry, unknown>>;
  return typeof candidate.register === "function" && typeof candidate.activeVersion === "function"
    && typeof candidate.subscribe === "function" && typeof candidate.pageApi === "object";
}

const bridges = new WeakMap<LegacyRegistry, VariantsRegistry>();

/** A version 2 view of a version 1 registry, one per registry, so callers that compare registries see the same one. */
function legacyBridge(legacy: LegacyRegistry): VariantsRegistry {
  const known = bridges.get(legacy);
  if (known) return known;
  const asLegacy = (definition: SlotDefinition) => ({
    slot: definition.slot, versions: definition.variants, defaultVersion: definition.defaultVariant,
  });
  const bridge = {
    pageApi: legacy.pageApi,
    register: (definition: SlotDefinition) => legacy.register(asLegacy(definition)),
    activeVariant: (definition: SlotDefinition) => legacy.activeVersion(asLegacy(definition)),
    subscribe: (listener: () => void) => legacy.subscribe(listener),
    // Selections in either version reach it in its own terms.
    select: (selection: unknown) => {
      const parsed = variantSelectionSchema.safeParse(upgradeMessage(selection));
      legacy.select?.(parsed.success
        ? { schemaVersion: LEGACY_SCHEMA_VERSION, slot: parsed.data.slot, version: parsed.data.variant }
        : selection);
    },
    getSnapshot: () => upgradeMessage(legacy.getSnapshot?.() ?? legacy.pageApi.getSnapshot()),
  } as unknown as VariantsRegistry;
  bridges.set(legacy, bridge);
  return bridge;
}

function isRegistryLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof VariantsRegistry, unknown>>;
  return typeof candidate.register === "function" && typeof candidate.activeVariant === "function"
    && typeof candidate.subscribe === "function" && typeof candidate.pageApi === "object";
}
