<!-- Placed after a slot: logs what `element` shows whenever `variants` change, as the update renders, after the
     slot's markup updates and before any `$effect` runs. -->
<script lang="ts">
  let { element, variants, log }: { element?: HTMLElement; variants: object; log: string[] } = $props();

  $effect.pre(() => {
    void variants;
    log.push(`shows ${element?.textContent?.trim()}`);
  });
</script>
