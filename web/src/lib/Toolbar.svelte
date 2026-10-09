<script lang="ts">
  import { parseSheet } from "./model";
  import { store, type SyncStatus } from "./sheet.svelte";

  interface Props {
    onOpenArchive: () => void;
  }
  const { onOpenArchive }: Props = $props();

  const STATUS: Record<SyncStatus, { label: string; title: string }> = {
    loading: { label: "…", title: "connecting to the eisenpaper server" },
    synced: {
      label: "✓ tasks.json",
      title: "sheet is stored in tasks.json — click to re-sync",
    },
    saving: { label: "saving…", title: "writing tasks.json" },
    offline: {
      label: "offline",
      title:
        "eisenpaper server unreachable — changes are kept in this browser and pushed once it is back (click to retry)",
    },
    error: {
      label: "sync error!",
      title:
        "the server rejected the sheet or tasks.json is invalid — see the browser console (click to retry)",
    },
  };

  let fileInput: HTMLInputElement | undefined = $state();
  const status = $derived(STATUS[store.status]);

  function onFresh(): void {
    const done = store.sheet.tasks.filter((t) => t.done).length;
    if (done === 0) {
      alert(
        "nothing crossed out yet — cross tasks out first, then start a fresh sheet.",
      );
      return;
    }
    const keep = store.sheet.tasks.length - done;
    if (
      confirm(
        `start a fresh sheet? ${String(done)} crossed-out task(s) go to the old sheets, ${String(keep)} stay.`,
      )
    )
      store.freshSheet();
  }

  function onExport(): void {
    const blob = new Blob([store.exportText()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `eisenpaper-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function onImport(): Promise<void> {
    const file = fileInput?.files?.[0];
    if (file === undefined || fileInput === undefined) return;
    fileInput.value = "";
    const sheet = parseSheet(await file.text());
    if (sheet === null) {
      alert("import failed: not an eisenpaper sheet");
      return;
    }
    if (
      confirm(
        `import ${String(sheet.tasks.length)} task(s) and ${String(sheet.archive.length)} old sheet(s)? this replaces the current sheet.`,
      )
    )
      store.replace(sheet);
  }
</script>

<nav class="bar">
  <button
    class="status"
    class:ok={store.status === "synced"}
    class:alert={store.status === "offline" || store.status === "error"}
    title={status.title}
    onclick={() => void store.sync()}>{status.label}</button
  >
  <button title="archive crossed-out tasks, keep the rest" onclick={onFresh}
    >fresh sheet</button
  >
  <button onclick={onOpenArchive}>old sheets</button>
  <button onclick={onExport}>export</button>
  <button onclick={() => fileInput?.click()}>import</button>
  <input
    bind:this={fileInput}
    type="file"
    accept="application/json"
    hidden
    onchange={() => void onImport()}
  />
</nav>

<style>
  .bar {
    position: fixed;
    top: 10px;
    right: 12px;
    z-index: 20;
    display: flex;
    gap: 6px;
    opacity: 0.45;
    transition: opacity 0.15s;
  }

  .bar:hover {
    opacity: 1;
  }

  .ok {
    color: var(--ok);
  }

  .alert {
    color: var(--accent);
  }
</style>
