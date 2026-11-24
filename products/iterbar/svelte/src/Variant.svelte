<script lang="ts">
  import type { VariantContent } from "./types.js";

  let { content }: { content: VariantContent | undefined } = $props();
</script>

{#if typeof content === "function"}
  {@const Content = content}
  <Content />
{:else if content}
  {@render content.snippet()}
{/if}
