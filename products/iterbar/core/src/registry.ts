import { z } from "zod";
import { InvalidMessageError, LEGACY_SCHEMA_VERSION, parseMessage, SCHEMA_VERSION } from "./errors.js";
import {
  isVariantName,
  pageUrlSchema,
  schemaVersionSchema,
  slotNameSchema,
  timestampSchema,
  variantNameSchema,
} from "./primitives.js";

/** Attribute that marks the root element of a rendered slot; its value is the slot name. */
export const SLOT_ATTRIBUTE = "data-iterbar-slot";

/** URL query parameter that selects variants: `?iterbar=pricing:v2,hero:b`. */
export const VARIANT_URL_PARAM = "iterbar";

/** Local storage key that remembers selections, in the same `slot:variant,...` format as the URL parameter. */
export const VARIANT_STORAGE_KEY = "iterbar:variants";

/** Name of the page API on `window` that the variants registry exposes to the bar. */
export const PAGE_API_GLOBAL = "__ITERBAR__";

/** One selected variant of one slot. */
export const activeVariantSchema = z.object({
  slot: slotNameSchema,
  variant: variantNameSchema,
});

/** Selected variants, at most one per slot. */
export const activeVariantsSchema = z.array(activeVariantSchema).max(256).refine(
  (variants) => new Set(variants.map((variant) => variant.slot)).size === variants.length,
  "each slot may appear only once",
);

/** One slot as the page registry currently sees it. */
export const slotStateSchema = z.object({
  slot: slotNameSchema,
  variants: z.array(variantNameSchema).min(1).max(64),
  defaultVariant: variantNameSchema,
  activeVariant: variantNameSchema,
  /** How many mounted `Variants` instances share this slot name. */
  mounts: z.number().int().positive(),
}).superRefine((slot, context) => {
  if (new Set(slot.variants).size !== slot.variants.length) {
    context.addIssue({ code: "custom", path: ["variants"], message: "variants must be unique" });
  }
  if (!slot.variants.includes(slot.defaultVariant)) {
    context.addIssue({ code: "custom", path: ["defaultVariant"], message: "defaultVariant must be one of variants" });
  }
  if (!slot.variants.includes(slot.activeVariant)) {
    context.addIssue({ code: "custom", path: ["activeVariant"], message: "activeVariant must be one of variants" });
  }
});

const slotStatesSchema = z.array(slotStateSchema).max(256).refine(
  (slots) => new Set(slots.map((slot) => slot.slot)).size === slots.length,
  "slot names must be unique",
);

/**
 * A selection the registry could not honour. A `url` or `storage` selection is replaced with the slot's
 * default; an `api` selection (from {@link IterbarPageApi.select}) leaves the slot unchanged.
 */
export const registryWarningSchema = z.object({
  code: z.enum(["unknown_slot", "unknown_variant", "invalid_selection"]),
  source: z.enum(["url", "storage", "api"]),
  /** The raw value as it appeared in the source; not necessarily a valid name. */
  value: z.string().max(1024),
  message: z.string().min(1).max(500),
});

/** Page -> bar: everything the registry knows. Delivered by `getSnapshot()` and to `subscribe()` listeners. */
export const registrySnapshotSchema = z.object({
  schemaVersion: schemaVersionSchema,
  slots: slotStatesSchema,
  warnings: z.array(registryWarningSchema).max(256),
});

/** Bar -> page: switch one slot to one of its variants. */
export const variantSelectionSchema = z.object({
  schemaVersion: schemaVersionSchema,
  slot: slotNameSchema,
  variant: variantNameSchema,
});

/** Bar -> daemon (`POST /slots`): the slots seen on one page, so agents can list them. */
export const slotReportSchema = z.object({
  schemaVersion: schemaVersionSchema,
  pageUrl: pageUrlSchema,
  reportedAt: timestampSchema,
  slots: slotStatesSchema,
});

export type ActiveVariant = z.infer<typeof activeVariantSchema>;
export type SlotState = z.infer<typeof slotStateSchema>;
export type RegistryWarning = z.infer<typeof registryWarningSchema>;
export type RegistrySnapshot = z.infer<typeof registrySnapshotSchema>;
export type VariantSelection = z.infer<typeof variantSelectionSchema>;
export type SlotReport = z.infer<typeof slotReportSchema>;

/** The `window.__ITERBAR__` object the variants registry installs and the bar reads. */
export interface IterbarPageApi {
  /** 2; a registry from the previous version says 1 and takes `{ schemaVersion: 1, slot, version }` selections. */
  readonly schemaVersion: typeof SCHEMA_VERSION | typeof LEGACY_SCHEMA_VERSION;
  getSnapshot(): RegistrySnapshot;
  /** Switches a slot in place. Unknown slots or variants are reported as `source: "api"` registry warnings, not thrown. */
  select(selection: VariantSelection): void;
  /** Calls `listener` with a new snapshot after every change; returns the unsubscribe function. */
  subscribe(listener: (snapshot: RegistrySnapshot) => void): () => void;
}

/**
 * Reads the page API from `target` (default `globalThis`). Returns `null` when no registry is installed,
 * throws `unsupported_schema_version` for a registry from another major version and `invalid_message`
 * for an object that lacks the v1 methods.
 */
export function readPageApi(target: unknown = globalThis): IterbarPageApi | null {
  if (typeof target !== "object" || target === null) return null;
  const candidate: unknown = (target as Record<string, unknown>)[PAGE_API_GLOBAL];
  if (candidate === undefined) return null;
  parseMessage(z.object({ schemaVersion: schemaVersionSchema }), candidate, PAGE_API_GLOBAL);
  const missing = (["getSnapshot", "select", "subscribe"] as const)
    .filter((method) => typeof (candidate as Record<string, unknown>)[method] !== "function");
  if (missing.length) {
    throw new InvalidMessageError(PAGE_API_GLOBAL, missing.map((method) => `${PAGE_API_GLOBAL}.${method}: must be a function`));
  }
  return candidate as IterbarPageApi;
}

/** Result of reading the `iterbar` URL parameter or the stored selection. */
export interface ParsedVariantParam {
  /** Well-formed selections in order; a later entry for the same slot replaces an earlier one. */
  readonly selections: readonly ActiveVariant[];
  /** Entries that are not `slot:variant` with valid names, verbatim. */
  readonly invalid: readonly string[];
}

/**
 * Parses `slot:variant,slot:variant`. Never throws. Surrounding whitespace around a well-formed entry is
 * ignored, as are blank entries; malformed entries are returned in `invalid` exactly as they appeared.
 */
export function parseVariantParam(value: string | null | undefined): ParsedVariantParam {
  const selections = new Map<string, ActiveVariant>();
  const invalid: string[] = [];
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    const slot = separator === -1 ? "" : trimmed.slice(0, separator);
    const variant = separator === -1 ? "" : trimmed.slice(separator + 1);
    if (!isVariantName(slot) || !isVariantName(variant)) {
      invalid.push(entry);
      continue;
    }
    selections.delete(slot);
    selections.set(slot, { slot, variant });
  }
  return { selections: [...selections.values()], invalid };
}

/** Serializes selections for the `iterbar` URL parameter or local storage. Throws `invalid_message` for bad names or repeated slots. */
export function formatVariantParam(selections: readonly ActiveVariant[]): string {
  const valid = parseMessage(activeVariantsSchema, selections, "selections");
  return valid.map((selection) => `${selection.slot}:${selection.variant}`).join(",");
}
