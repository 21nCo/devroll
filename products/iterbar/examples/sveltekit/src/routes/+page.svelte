<script lang="ts">
  import { Variants } from "@iterbar/svelte";
  import BoldHero from "$lib/BoldHero.svelte";
  import CalmHero from "$lib/CalmHero.svelte";
</script>

<!-- One page, two slots. In `vite dev` the Iterbar bar switches between their variants. -->
{#snippet table()}
  <table id="pricing">
    <tbody>
      <tr><th scope="row">Starter</th><td>$9</td></tr>
      <tr><th scope="row">Team</th><td>$29</td></tr>
    </tbody>
  </table>
{/snippet}
{#snippet cards()}
  <ul id="pricing">
    <li>Starter: $9</li>
    <li>Team: $29</li>
  </ul>
{/snippet}

<main>
  <Variants slot="hero" variants={{ calm: CalmHero, bold: BoldHero }} default="calm" />
  <Variants slot="pricing" variants={{ table: { snippet: table }, cards: { snippet: cards } }} default="table" />
</main>
