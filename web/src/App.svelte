<script lang="ts">
  import { onMount } from "svelte";

  import ArchivePanel from "./lib/ArchivePanel.svelte";
  import Note from "./lib/Note.svelte";
  import { store } from "./lib/sheet.svelte";
  import Toolbar from "./lib/Toolbar.svelte";

  let archiveOpen = $state(false);
  const empty = $derived(
    store.sheet.tasks.length === 0 && store.draft === null,
  );

  onMount(() => store.start());

  function ondblclick(e: MouseEvent): void {
    if (e.target !== e.currentTarget) return; // a note handles its own dblclick
    store.addDraft(e.clientX / innerWidth, e.clientY / innerHeight);
  }
</script>

<main class="pane" {ondblclick}>
  <div class="axis x"></div>
  <div class="axis y"></div>
  <span class="axis-label urgent">urgent &rarr;</span>
  <span class="axis-label important">&uarr; important</span>
  <span class="quadrant do">do</span>
  <span class="quadrant schedule">schedule</span>
  <span class="quadrant delegate">delegate</span>
  <span class="quadrant drop">drop</span>

  {#if empty}
    <div class="hint">
      double-click anywhere to jot a task<br />
      <small
        >click = cross out &middot; double-click = edit &middot; drag =
        reprioritize &middot; right-click = tear off</small
      >
    </div>
  {/if}

  {#each store.sheet.tasks as task (task.id)}
    <Note {task} editing={store.editingId === task.id} />
  {/each}
  {#if store.draft}
    <Note task={store.draft} editing />
  {/if}
</main>

<Toolbar onOpenArchive={() => (archiveOpen = true)} />
<ArchivePanel bind:open={archiveOpen} />

<style>
  .pane {
    position: fixed;
    inset: 0;
    cursor: crosshair;
  }

  .axis,
  .axis-label,
  .quadrant,
  .hint {
    position: absolute;
    pointer-events: none;
  }

  .axis {
    background: var(--pencil);
    opacity: 0.5;
  }

  .x {
    left: 3%;
    right: 3%;
    top: 50%;
    height: 1.5px;
  }

  .y {
    top: 4%;
    bottom: 4%;
    left: 50%;
    width: 1.5px;
  }

  .axis-label {
    color: var(--pencil);
    font-size: 15px;
    opacity: 0.8;
    letter-spacing: 0.5px;
  }

  .urgent {
    right: 3%;
    top: calc(50% + 8px);
  }

  .important {
    left: calc(50% + 10px);
    top: 4%;
  }

  .quadrant {
    color: var(--faint);
    font-size: clamp(18px, 3.2vw, 30px);
    opacity: 0.55;
    font-weight: bold;
  }

  .do {
    right: 5%;
    top: 6%;
  }

  .schedule {
    left: 5%;
    top: 6%;
  }

  .delegate {
    right: 5%;
    bottom: 6%;
  }

  .drop {
    left: 5%;
    bottom: 6%;
  }

  .hint {
    left: 50%;
    top: 30%;
    transform: translateX(-50%) rotate(-1.5deg);
    color: var(--pencil);
    font-size: 21px;
    opacity: 0.75;
    text-align: center;
  }
</style>
