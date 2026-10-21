<script lang="ts">
  import { onMount } from "svelte";

  import ArchivePanel from "./lib/ArchivePanel.svelte";
  import DetailPane from "./lib/DetailPane.svelte";
  import PaneTabs from "./lib/PaneTabs.svelte";
  import PriorityPane from "./lib/PriorityPane.svelte";
  import SchedulePane from "./lib/SchedulePane.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import { store } from "./lib/sheet.svelte";
  import { today } from "./lib/today.svelte";
  import Toolbar from "./lib/Toolbar.svelte";

  /** which pane is open is a per-device view preference, not sheet data */
  const PANE_KEY = "eisenpaper.pane";

  let archiveOpen = $state(false);
  let settingsOpen = $state(false);
  /** Storage the browser blocks degrades to the default pane. */
  function savedPane(): string | null {
    try {
      return localStorage.getItem(PANE_KEY);
    } catch (e) {
      console.warn("browser storage unavailable", e);
      return null;
    }
  }

  let pane = $state(
    savedPane() === "schedule" ? ("schedule" as const) : ("priority" as const),
  );

  $effect(() => {
    try {
      localStorage.setItem(PANE_KEY, pane);
    } catch (e) {
      console.warn("saving the open pane in the browser failed", e);
    }
  });

  // the panes make room for the detail pane (see --pane-right in app.css)
  $effect(() => {
    document.documentElement.classList.toggle(
      "detail-open",
      store.selected !== undefined,
    );
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

<DetailPane onManageProjects={() => (settingsOpen = true)} />
<Toolbar
  onOpenArchive={() => (archiveOpen = true)}
  onOpenSettings={() => (settingsOpen = true)}
/>
<ArchivePanel bind:open={archiveOpen} />
<SettingsPanel bind:open={settingsOpen} />
