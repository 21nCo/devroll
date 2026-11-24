import type { Component, Snippet } from "svelte";

/** A Svelte component that needs no props, such as `PricingV2`, rendered as `<PricingV2 />`. */
export type VariantComponent = Component<Record<string, never>>;

/**
 * Markup for a variant, such as `{ snippet: compact }` for `{#snippet compact()}<Pricing compact />{/snippet}`.
 * Svelte cannot tell a snippet from a component at runtime, so a snippet goes in an object.
 */
export interface VariantSnippet {
  readonly snippet: Snippet;
}

/** One variant of a slot: a component that takes no props, or `{ snippet }` for any other markup. */
export type VariantContent = VariantComponent | VariantSnippet;

/** @deprecated Use {@link VariantContent}. */
export type VersionContent = VariantContent;
/** @deprecated Use {@link VariantComponent}. */
export type VersionComponent = VariantComponent;
/** @deprecated Use {@link VariantSnippet}. */
export type VersionSnippet = VariantSnippet;

/** Props for `Variants`. */
export type VariantsProps<VariantMap extends Readonly<Record<string, VariantContent>>> = {
  /** The slot name shown in the bar and used in the `iterbar` URL parameter, such as `pricing`. */
  readonly slot: string;
  /** The variant to render when nothing selects another, and the only one rendered in production. */
  readonly default: Extract<keyof VariantMap, string>;
  /**
   * A short description of some or all variants (what each one tries), by variant name, shown under each name in the
   * bar's Variants popover; at most 200 characters each. Development only, like the rest.
   */
  readonly descriptions?: Readonly<Partial<Record<Extract<keyof VariantMap, string>, string>>>;
} & (
  | {
    /** Each variant, keyed by variant name (1-64 letters, digits, `_`, `.` or `-`). */
    readonly variants: VariantMap;
    readonly versions?: undefined;
  }
  | {
    /** @deprecated Use `variants`. The earlier name, still accepted for one version. */
    readonly versions: VariantMap;
    readonly variants?: undefined;
  }
);

/** {@link VariantsProps} with the variants under their current name, as the implementations take them. */
export interface ResolvedVariantsProps<VariantMap extends Readonly<Record<string, VariantContent>>> {
  readonly slot: string;
  readonly variants: VariantMap;
  readonly default: Extract<keyof VariantMap, string>;
  readonly descriptions?: Readonly<Partial<Record<string, string>>>;
}
