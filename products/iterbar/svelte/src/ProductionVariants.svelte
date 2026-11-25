<script lang="ts">
  import { variantContent } from "./content.js";
  import type { ResolvedVariantsProps, VariantContent } from "./types.js";
  import Variant from "./Variant.svelte";

  let props: ResolvedVariantsProps<Readonly<Record<string, VariantContent>>> = $props();
</script>

<Variant content={variantContent(props.variants, props.default)} />
