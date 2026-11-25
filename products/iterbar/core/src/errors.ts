import type { z } from "zod";

/**
 * The protocol major version this package writes. Version 2 renamed a slot's "versions" to "variants"
 * (`variants`, `defaultVariant`, `activeVariant`, and `variant` in selections, choices and active variants).
 */
export const SCHEMA_VERSION = 2 as const;

/** The previous major version, still read for one version: its messages are upgraded on input (see {@link upgradeMessage}). */
export const LEGACY_SCHEMA_VERSION = 1 as const;

/** Protocol major versions this package can read. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = Object.freeze([LEGACY_SCHEMA_VERSION, SCHEMA_VERSION]);

/** Stable machine-readable codes carried by every {@link IterbarContractError}. */
export type IterbarContractErrorCode =
  | "invalid_message"
  | "unsupported_schema_version"
  | "invalid_path_segment"
  | "invalid_project_root";

const contractErrorCodes: ReadonlySet<string> = new Set<IterbarContractErrorCode>([
  "invalid_message",
  "unsupported_schema_version",
  "invalid_path_segment",
  "invalid_project_root",
]);

/** Base class for every error this package throws on purpose. Match on `code`, not on the class, across bundles. */
export class IterbarContractError extends Error {
  readonly code: IterbarContractErrorCode;

  constructor(code: IterbarContractErrorCode, message: string) {
    super(message);
    this.name = "IterbarContractError";
    this.code = code;
  }
}

/** A message declared a protocol major version this reader does not understand. */
export class UnsupportedSchemaVersionError extends IterbarContractError {
  readonly receivedVersion: number;
  readonly supportedVersions: readonly number[] = SUPPORTED_SCHEMA_VERSIONS;

  constructor(label: string, receivedVersion: number) {
    super(
      "unsupported_schema_version",
      `${label} uses schemaVersion ${receivedVersion}; this reader supports ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.receivedVersion = receivedVersion;
  }
}

/** A message with a supported (or missing) version that does not match its schema. */
export class InvalidMessageError extends IterbarContractError {
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super("invalid_message", `Invalid ${label}: ${issues.join("; ")}`);
    this.name = "InvalidMessageError";
    this.issues = Object.freeze([...issues]);
  }
}

/** True for any error raised by this package, including copies loaded from another bundle. */
export function isIterbarContractError(error: unknown): error is IterbarContractError {
  return error instanceof IterbarContractError
    || (error instanceof Error && contractErrorCodes.has((error as { code?: unknown }).code as string));
}

export type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: IterbarContractError };

/**
 * Rejects an object whose `schemaVersion` is a different positive integer major version before any
 * shape check, so a newer writer's message is never half-read as v1. Missing or malformed versions are
 * left to the schema, which reports them as an invalid message.
 */
export function assertSupportedSchemaVersion(input: unknown, label = "message"): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  // `in`, not an own-property check: the schema reads inherited properties too, so the version check must.
  if (!("schemaVersion" in input)) return;
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isSafeInteger(version) && version >= 1
    && !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    throw new UnsupportedSchemaVersionError(label, version);
  }
}

/** Version 1 field names and the version 2 names they became. */
const V1_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  versions: "variants",
  defaultVersion: "defaultVariant",
  activeVersion: "activeVariant",
  version: "variant",
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Any realm's Object.prototype (an iframe's page API hands over its own realm's objects), or none; not a class instance.
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * `value` with the version 1 fields in `legacyKeys` renamed to their version 2 names, every other field kept. A version
 * 2 name next to its version 1 field was an unknown, ignored field in version 1: the version 1 field decides, in any
 * key order.
 */
function renameFields(value: unknown, legacyKeys: readonly string[]): unknown {
  if (!isPlainRecord(value)) return value;
  const renamed = new Set(legacyKeys.filter((key) => Object.hasOwn(value, key)).map((key) => V1_RENAMES[key]!));
  const upgraded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (renamed.has(key)) continue;
    // Defined, not assigned, so a JSON field named `__proto__` stays an ordinary field.
    Object.defineProperty(upgraded, legacyKeys.includes(key) ? V1_RENAMES[key]! : key, {
      value: item, enumerable: true, writable: true, configurable: true,
    });
  }
  return upgraded;
}

/**
 * Helpers for the version 1 upgrades the schemas declare with {@link withLegacyUpgrade}. Each takes a value as it
 * came in and returns a copy; anything it does not expect (not an object, a missing field) passes through unchanged,
 * for the schema to judge.
 * @internal
 */
export const legacyUpgrade = Object.freeze({
  /**
   * A message's own fields, `schemaVersion` set to 2 when it was 1 (its own fields only: the schema reads the version
   * even when inherited), and the fields under `keys` upgraded with `upgrade`; every other field is kept as it is.
   */
  message(value: unknown, keys: Readonly<Record<string, (item: unknown) => unknown>> = {}): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const copy: Record<string, unknown> = { ...value };
    if ((value as { schemaVersion?: unknown }).schemaVersion === LEGACY_SCHEMA_VERSION) copy.schemaVersion = SCHEMA_VERSION;
    for (const [key, upgrade] of Object.entries(keys)) if (Object.hasOwn(copy, key)) copy[key] = upgrade(copy[key]);
    return copy;
  },
  /** A slot state with its version 1 fields renamed (`versions`, `defaultVersion`, `activeVersion`); nothing else. */
  slotFields(value: unknown): unknown {
    return renameFields(value, ["versions", "defaultVersion", "activeVersion"]);
  },
  /** An active variant, choice or selection with its version 1 `version` renamed; nothing else. */
  variantField(value: unknown): unknown {
    return renameFields(value, ["version"]);
  },
  /** `upgrade` applied to each item of an array; anything else as it is. */
  each(upgrade: (item: unknown) => unknown): (value: unknown) => unknown {
    return (value) => (Array.isArray(value) ? value.map(upgrade) : value);
  },
  /** A registry warning with the version 1 code `unknown_version` renamed. */
  warning(value: unknown): unknown {
    return isPlainRecord(value) && value.code === "unknown_version" ? { ...value, code: "unknown_variant" } : value;
  },
});

const LEGACY_UPGRADE = Symbol("iterbar.legacyUpgrade");

/**
 * Declares how a version 1 message read with `schema` becomes version 2 (see {@link upgradeMessage}). The upgrade
 * knows the message's type from its schema, so it renames exactly that type's fields and nothing else. Returns
 * `schema`.
 */
export function withLegacyUpgrade<S extends z.ZodType>(schema: S, upgrade: (input: unknown) => unknown): S {
  Object.defineProperty(schema, LEGACY_UPGRADE, { value: upgrade, enumerable: false });
  return schema;
}

/**
 * A version 1 message read with `schema`, rewritten as version 2: the schema's declared upgrade renames that message
 * type's slot fields (`versions`, `defaultVersion`, `activeVersion`, `version`) at the paths the protocol defines
 * them, nested messages included, and sets `schemaVersion` to 2. A schema without one only has its `schemaVersion`
 * set. Extension fields an older writer added are kept as they are, whatever their names. Any other input (version 2,
 * not an object) is returned as it is. {@link parseMessage} applies it before checking the shape, so stored items and
 * older bars and pages keep working for one version.
 */
export function upgradeMessage(input: unknown, schema?: z.ZodType): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  if ((input as { schemaVersion?: unknown }).schemaVersion !== LEGACY_SCHEMA_VERSION) return input;
  const upgrade = (schema as { [LEGACY_UPGRADE]?: (input: unknown) => unknown } | undefined)?.[LEGACY_UPGRADE];
  return upgrade ? upgrade(input) : legacyUpgrade.message(input);
}

/**
 * Reads a versioned protocol message, upgrading a version 1 message first. Throws
 * {@link UnsupportedSchemaVersionError} for any other major version and {@link InvalidMessageError} for anything else
 * that does not match `schema`. Unknown
 * properties are dropped, so additive v1 fields from a newer writer are tolerated.
 */
export function parseMessage<S extends z.ZodType>(schema: S, input: unknown, label = "message"): z.output<S> {
  assertSupportedSchemaVersion(input, label);
  const result = schema.safeParse(upgradeMessage(input, schema));
  if (!result.success) {
    throw new InvalidMessageError(label, result.error.issues.map((issue) =>
      `${[label, ...issue.path.map(String)].join(".")}: ${issue.message}`));
  }
  return result.data;
}

/** {@link parseMessage} for JSON text; malformed JSON is an invalid message. */
export function parseMessageJson<S extends z.ZodType>(schema: S, text: string, label = "message"): z.output<S> {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new InvalidMessageError(label, [`${label}: not valid JSON (${(error as Error).message})`]);
  }
  return parseMessage(schema, input, label);
}

/** Non-throwing {@link parseMessage}. */
export function safeParseMessage<S extends z.ZodType>(
  schema: S,
  input: unknown,
  label = "message",
): ParseResult<z.output<S>> {
  try {
    return { success: true, data: parseMessage(schema, input, label) };
  } catch (error) {
    if (isIterbarContractError(error)) return { success: false, error };
    throw error;
  }
}
