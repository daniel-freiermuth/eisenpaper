<script lang="ts">
  import { onMount } from "svelte";

  import ArchivePanel from "./lib/ArchivePanel.svelte";
  import PaneTabs from "./lib/PaneTabs.svelte";
  import PriorityPane from "./lib/PriorityPane.svelte";
  import SchedulePane from "./lib/SchedulePane.svelte";
  import { store } from "./lib/sheet.svelte";
  import { today } from "./lib/today.svelte";
  import Toolbar from "./lib/Toolbar.svelte";

  /** which pane is open is a per-device view preference, not sheet data */
  const PANE_KEY = "eisenpaper.pane";

  let archiveOpen = $state(false);
  let pane = $state(
    localStorage.getItem(PANE_KEY) === "schedule"
      ? ("schedule" as const)
      : ("priority" as const),
  );

  $effect(() => {
    localStorage.setItem(PANE_KEY, pane);
  });

  onMount(() => {
    const stopSync = store.start();
    const stopClock = today.start();
    return () => {
      stopSync();
      stopClock();
    };
  });
</script>

<PaneTabs bind:pane />
{#if pane === "priority"}
  <PriorityPane />
{:else}
  <SchedulePane />
{/if}

<Toolbar onOpenArchive={() => (archiveOpen = true)} />
<ArchivePanel bind:open={archiveOpen} />
