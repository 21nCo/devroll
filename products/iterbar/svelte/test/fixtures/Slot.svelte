<!-- Variants with every prop from the test, optionally under a VariantsProvider. -->
<script lang="ts">
  import type { VariantsRegistry } from "@iterbar/variants";
  import { Variants, VariantsProvider, type VariantContent } from "../../src/index.js";

  let {
    slot,
    variants,
    default: defaultVariant,
    registry,
  }: { slot: string; variants: Record<string, VariantContent>; default: string; registry?: VariantsRegistry } = $props();
</script>

{#if registry}
  <VariantsProvider {registry}>
    <div><Variants {slot} {variants} default={defaultVariant} /></div>
  </VariantsProvider>
{:else}
  <Variants {slot} {variants} default={defaultVariant} />
{/if}
