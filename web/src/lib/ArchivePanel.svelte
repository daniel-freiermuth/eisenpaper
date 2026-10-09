<script lang="ts">
  import { store } from "./sheet.svelte";

  interface Props {
    open?: boolean;
  }
  let { open = $bindable(false) }: Props = $props();

  const newestFirst = $derived(store.sheet.archive.toReversed());
</script>

<aside class:open aria-hidden={!open} inert={!open}>
  <button class="close" onclick={() => (open = false)}>close</button>
  <h2>old sheets</h2>
  {#each newestFirst as sheet (sheet.at)}
    <section>
      <div class="date">{new Date(sheet.at).toLocaleString()}</div>
      {#each sheet.tasks as task (task.id)}
        <div class="task" class:done={task.done}>{task.text}</div>
      {/each}
    </section>
  {:else}
    <p>no old sheets yet.</p>
  {/each}
</aside>

<style>
  aside {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 90vw);
    background: #efe9d8;
    border-left: 2px solid var(--faint);
    box-shadow: -4px 0 18px rgb(43 42 38 / 15%);
    transform: translateX(105%);
    transition: transform 0.2s ease;
    z-index: 30;
    padding: 18px;
    overflow-y: auto;
  }

  .open {
    transform: none;
  }

  h2 {
    margin: 0 0 4px;
    font-size: 22px;
  }

  section {
    margin: 14px 0;
    border-top: 1px dashed var(--faint);
    padding-top: 8px;
  }

  .date {
    color: var(--pencil);
    font-size: 14px;
  }

  .task {
    font-size: 17px;
  }

  .done {
    text-decoration: line-through;
    color: var(--pencil);
  }

  .close {
    float: right;
  }
</style>
