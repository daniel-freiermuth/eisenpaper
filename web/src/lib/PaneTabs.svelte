<script lang="ts" module>
  export type Pane = "priority" | "schedule";
</script>

<script lang="ts">
  interface Props {
    pane?: Pane;
  }
  let { pane = $bindable("priority") }: Props = $props();

  const TABS: { id: Pane; label: string }[] = [
    { id: "priority", label: "priorities" },
    { id: "schedule", label: "schedule" },
  ];

  function select(id: Pane): void {
    // commit a note being edited before its pane unmounts
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    pane = id;
  }
</script>

<nav class="tabs" aria-label="panes">
  {#each TABS as tab (tab.id)}
    <button
      class:active={pane === tab.id}
      aria-current={pane === tab.id ? "page" : undefined}
      onclick={() => {
        select(tab.id);
      }}>{tab.label}</button
    >
  {/each}
</nav>

<style>
  .tabs {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 25;
    width: var(--tabs-w);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 18px;
    border-right: 1.5px solid rgb(from var(--pencil) r g b / 55%);
    background: #ebe4d0;
  }

  button {
    /* reads bottom-to-top, like the spine label of a binder tab */
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    margin-right: -1.5px;
    padding: 14px 0;
    font-size: 16px;
    letter-spacing: 1px;
    color: var(--pencil);
    background: #e2dac3;
    border: 1.5px solid rgb(from var(--pencil) r g b / 45%);
    /* rotated 180°: the element's left edge is the visual right one */
    border-left: none;
    border-radius: 0 6px 6px 0;
  }

  button:hover {
    color: var(--ink);
    background: #efe9d8;
  }

  .active {
    color: var(--ink);
    border-color: rgb(from var(--pencil) r g b / 55%);
    background: var(--paper);
  }
</style>
