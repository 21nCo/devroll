<script lang="ts">
  import { Variants } from "../../src/index.js";
  import PlanOne from "./PlanOne.svelte";
  import PlanTwo from "./PlanTwo.svelte";
</script>

<Variants slot="pricing" variants={{ v1: PlanOne, v2: PlanTwo }} default="v1" />
