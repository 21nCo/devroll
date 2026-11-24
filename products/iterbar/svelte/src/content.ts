import type { ResolvedVariantsProps, VariantContent, VariantsProps } from "./types.js";

/** The content of `variant`, or `undefined` when `variants` has no own entry with that name. */
export function variantContent(
  variants: Readonly<Record<string, VariantContent>>,
  variant: string,
): VariantContent | undefined {
  return Object.hasOwn(variants, variant) ? variants[variant] : undefined;
}

/** The variants from `variants`, or from the earlier `versions`. */
export function resolveVariantsProps<VariantMap extends Readonly<Record<string, VariantContent>>>(
  props: VariantsProps<VariantMap>,
): ResolvedVariantsProps<VariantMap> {
  return { slot: props.slot, default: props.default, variants: (props.variants ?? props.versions)! };
}
