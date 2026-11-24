<script lang="ts">
  import {
    getVariantsRegistry,
    markSlotRange,
    validateSlotDefinition,
    type SlotRegistration,
  } from "@iterbar/variants";
  import { variantContent } from "./content.js";
  import { providedRegistry } from "./context.js";
  import type { ResolvedVariantsProps, VariantContent } from "./types.js";
  import { untrack } from "svelte";
  import Variant from "./Variant.svelte";

  let { slot, variants, default: defaultVariant, descriptions }: ResolvedVariantsProps<Readonly<Record<string, VariantContent>>> = $props();

  const readProvided = providedRegistry();
  // Derived, so the effect below re-registers only when the provided registry itself changes.
  const provided = $derived(readProvided());
  // A string, so new props with the same slot, variant names and default do not register the slot again.
  const key = $derived(JSON.stringify([slot, Object.keys(variants), defaultVariant, descriptions ?? null]));
  // Throws `invalid_message` for an invalid slot, variant name, default or description.
  const definition = $derived.by(() => {
    const [name, names, initial, described] = JSON.parse(key) as [string, string[], string, Record<string, string> | null];
    return validateSlotDefinition({ slot: name, variants: names, defaultVariant: initial, ...(described ? { descriptions: described } : {}) });
  });
  // Svelte gives an instance that hydrates server markup the server's id (`s1`, or `prefix-s1`) and a new
  // client instance `c1`, `c2`, ...: unlike a DOM query, this holds for any hydration target and id prefix.
  const instance = $props.id();
  const hydrating = !/^c\d+$/.test(instance);
  // Whether to render the registry's selection rather than the default. The server runs no effects, so it
  // renders the default and never reaches the registry or `window`. In the browser this is set before the
  // template first renders: a client mount renders the selected variant at once, as React's
  // useSyncExternalStore does; a hydrating instance hydrates the default, and the effect below switches right
  // after hydration.
  let live = $state(false);
  $effect.pre(() => {
    live = !hydrating;
  });
  // Counts registry changes, so `activeVariant` reads the registry's selection again after each one.
  let changes = $state(0);
  // Read while rendering: new variants without the active one render their default in the same update.
  const activeVariant = $derived.by(() => {
    void changes;
    const current = definition;
    return live ? (provided ?? getVariantsRegistry()).activeVariant(current) : current.defaultVariant;
  });
  let start = $state<HTMLTemplateElement>();
  let end = $state<HTMLTemplateElement>();

  // The slot, variant names and default, which registering depends on; the descriptions are applied in place below,
  // so a description change keeps this instance's place among the slot's mounts.
  const baseKey = $derived(JSON.stringify([slot, Object.keys(variants), defaultVariant]));
  let registration: SlotRegistration | null = null;

  // Runs only in the browser, after mount: registers the slot and follows the registry's selections.
  $effect(() => {
    void baseKey;
    const current = untrack(() => definition);
    const registry = provided ?? getVariantsRegistry();
    // Untracked: registering notifies at once, and this effect must not depend on the count it bumps.
    const unsubscribe = registry.subscribe(() => untrack(() => (changes += 1)));
    let unregister: SlotRegistration;
    try {
      unregister = registry.register(current);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    registration = unregister;
    live = true;
    return () => {
      unsubscribe();
      unregister();
      if (registration === unregister) registration = null;
    };
  });

  // A description change updates the registration in place (a version 1 registry knows no descriptions).
  $effect(() => {
    const descriptions = definition.descriptions;
    untrack(() => registration?.describe?.(descriptions));
  });

  // Re-run on every switch so the new variant's elements are marked as soon as it renders; between switches,
  // the range observer follows elements the variant itself adds or replaces.
  $effect(() => {
    void activeVariant;
    if (!start || !end) return undefined;
    return markSlotRange(start, end, definition.slot);
  });
</script>

<template bind:this={start} data-iterbar-slot-boundary="start"></template>
{#key activeVariant}
  <Variant content={variantContent(variants, activeVariant)} />
{/key}
<template bind:this={end} data-iterbar-slot-boundary="end"></template>
