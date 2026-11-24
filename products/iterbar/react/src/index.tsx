"use client";

import {
  getVariantsRegistry,
  markSlotRange,
  SLOT_BOUNDARY_ATTRIBUTE,
  validateSlotDefinition,
  type SlotRange,
  type VariantsRegistry,
} from "@iterbar/variants";
import {
  createContext,
  createElement,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type JSX,
  type ReactNode,
} from "react";

export type { VariantsRegistry } from "@iterbar/variants";

/**
 * One variant of a slot: a component that takes no props (`PricingV2`), rendered as `<PricingV2 />`, or any
 * React node (`<PricingV2 compact />`, text, `null`).
 */
export type VariantContent = ComponentType | ReactNode;

/** @deprecated Use {@link VariantContent}. */
export type VersionContent = VariantContent;

/** Props for {@link Variants}. */
export type VariantsProps<VariantMap extends Readonly<Record<string, VariantContent>>> = {
  /** The slot name shown in the bar and used in the `iterbar` URL parameter, such as `pricing`. */
  readonly slot: string;
  /** The variant to render when nothing selects another, and the only one rendered in production. */
  readonly default: Extract<keyof VariantMap, string>;
  /**
   * A short description of some or all variants (what each one tries), by variant name, shown under each name in the
   * bar's Variants popover; at most 160 characters each. Development only, like the rest.
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
interface ResolvedVariantsProps<VariantMap extends Readonly<Record<string, VariantContent>>> {
  readonly slot: string;
  readonly variants: VariantMap;
  readonly default: Extract<keyof VariantMap, string>;
  readonly descriptions?: Readonly<Partial<Record<string, string>>>;
}

/** The variants from `variants`, or from the earlier `versions`. */
function resolveVariantsProps<VariantMap extends Readonly<Record<string, VariantContent>>>(
  props: VariantsProps<VariantMap>,
): ResolvedVariantsProps<VariantMap> {
  return { slot: props.slot, default: props.default, variants: (props.variants ?? props.versions)!, descriptions: props.descriptions };
}

const RegistryContext = /* @__PURE__ */ createContext<VariantsRegistry | null>(null);

/**
 * Makes every {@link Variants} below it use `registry` instead of the page's shared registry, for example in
 * tests or in a second React root that must not appear in `window.__ITERBAR__`.
 */
export function VariantsProvider({ registry, children }: {
  readonly registry: VariantsRegistry;
  readonly children?: ReactNode;
}): JSX.Element {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/** `memo`, `forwardRef` and `lazy` components are objects rather than functions. */
const COMPONENT_OBJECT_TYPES = new Set<unknown>([
  Symbol.for("react.memo"),
  Symbol.for("react.forward_ref"),
  Symbol.for("react.lazy"),
]);

function isComponentType(content: VariantContent): content is ComponentType {
  if (typeof content === "function") return true;
  return typeof content === "object" && content !== null
    && COMPONENT_OBJECT_TYPES.has((content as { $$typeof?: unknown }).$$typeof);
}

function renderVariant(variants: Readonly<Record<string, VariantContent>>, variant: string): ReactNode {
  if (!Object.hasOwn(variants, variant)) return null;
  const content = variants[variant];
  return isComponentType(content) ? createElement(content) : content;
}

/**
 * Renders one variant of a slot. In development the variant comes from the `iterbar` URL parameter
 * (`?iterbar=pricing:v2`), then local storage, then `default`, and the bar can switch it in place through
 * `window.__ITERBAR__`. The variant's top-level elements are marked with `data-iterbar-slot`; empty
 * `<template>` elements before and after it delimit the slot, so it adds no wrapper and stays valid inside
 * `<p>`, `<ul>` and `<tbody>`. A slot rendered at the top level of another slot's variant keeps its own marks:
 * each element is marked with the innermost slot that renders it.
 *
 * Development means `process.env.NODE_ENV === "development"`; any other value, or none, renders `default`
 * only, with no markers and no registry; so does a page without a `process` global when nothing replaced
 * `process.env.NODE_ENV`. The condition is written inline, so a bundler that replaces it needs no `process`
 * global and drops the development code from other builds.
 */
export function Variants<VariantMap extends Readonly<Record<string, VariantContent>>>(
  props: VariantsProps<VariantMap>,
): JSX.Element {
  // The bare check folds to a literal once a bundler replaces `process.env.NODE_ENV`, even inside `try`, so
  // other builds drop DevelopmentVariants and a development build needs no `process` global. Without that
  // replacement, a page with no `process` (or no `process.env`) is not development.
  try {
    if (process.env.NODE_ENV === "development") return <DevelopmentVariants {...resolveVariantsProps(props)} />;
  } catch {
    // Not development.
  }
  return <>{renderVariant(resolveVariantsProps(props).variants, props.default)}</>;
}

function DevelopmentVariants<VariantMap extends Readonly<Record<string, VariantContent>>>({
  slot,
  variants,
  default: defaultVariant,
  descriptions,
}: ResolvedVariantsProps<VariantMap>): JSX.Element {
  const providedRegistry = useContext(RegistryContext);
  const variantNames = JSON.stringify(Object.keys(variants));
  // Compared as text, so a descriptions object written inline in JSX does not register the slot again on every render.
  const descriptionText = descriptions ? JSON.stringify(descriptions) : null;
  // Throws `invalid_message` during render for an invalid slot, variant name, default or description.
  const definition = useMemo(
    () => validateSlotDefinition({
      slot, variants: JSON.parse(variantNames) as string[], defaultVariant,
      ...(descriptionText === null ? {} : { descriptions: JSON.parse(descriptionText) as Record<string, string> }),
    }),
    [slot, variantNames, defaultVariant, descriptionText],
  );
  const registry = useCallback(() => providedRegistry ?? getVariantsRegistry(), [providedRegistry]);
  const subscribe = useCallback((onChange: () => void) => registry().subscribe(onChange), [registry]);
  const getSnapshot = useCallback(() => registry().activeVariant(definition), [registry, definition]);
  const getServerSnapshot = useCallback(() => definition.defaultVariant, [definition]);
  const activeVariant = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const start = useRef<HTMLTemplateElement>(null);
  const end = useRef<HTMLTemplateElement>(null);
  const range = useRef<SlotRange | null>(null);

  useEffect(() => registry().register(definition), [registry, definition]);

  // Re-run on every switch so the new variant's elements are marked as soon as it commits; between
  // switches, the range observer follows elements the variant itself adds or replaces.
  useEffect(() => {
    if (!start.current || !end.current) return undefined;
    const handle = markSlotRange(start.current, end.current, definition.slot);
    range.current = handle;
    return () => {
      handle();
      if (range.current === handle) range.current = null;
    };
  }, [definition.slot, activeVariant]);

  // After every commit, mark the range again where it lives now, which covers a move no observer can see.
  useEffect(() => {
    range.current?.refresh();
  });

  return (
    <>
      <template ref={start} {...{ [SLOT_BOUNDARY_ATTRIBUTE]: "start" }} />
      <Fragment key={activeVariant}>{renderVariant(variants, activeVariant)}</Fragment>
      <template ref={end} {...{ [SLOT_BOUNDARY_ATTRIBUTE]: "end" }} />
    </>
  );
}
