<script lang="ts">
  import { drag, draggable } from "./drag.svelte";
  import type { Task } from "./model";
  import { store } from "./sheet.svelte";

  interface Props {
    task: Task;
    /** shown after the text, e.g. the day an overdue task was due */
    label?: string | undefined;
    /** offer a button that sends the task back to the backlog */
    unschedulable?: boolean;
  }
  const { task, label, unschedulable = false }: Props = $props();

  function onDrop(zone: string, index: number): void {
    if (zone === "overdue") return; // past days are not a target
    store.schedule(task.id, zone === "backlog" ? null : zone, index);
  }

  function onkeydown(e: KeyboardEvent): void {
    // keys on the × button are the button's own, not a tap on the scrap
    if (e.target !== e.currentTarget) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      store.toggleDone(task);
    }
  }
</script>

<div
  class="scrap"
  class:done={task.done}
  class:lifted={drag.current?.id === task.id}
  data-id={task.id}
  role="button"
  tabindex="0"
  aria-pressed={task.done}
  {onkeydown}
  {@attach draggable({
    id: task.id,
    text: task.text,
    done: task.done,
    onTap: () => {
      store.toggleDone(task);
    },
    onDrop,
  })}
>
  <!-- the inline span keeps the strike-through to the words, line by line -->
  <span class="body"><span class="txt">{task.text}</span></span>
  {#if label !== undefined}
    <span class="when">{label}</span>
  {/if}
  {#if unschedulable}
    <!-- a capture handler is attached natively, so it stops the press before
         the scrap's own pointerdown listener can turn it into a tap; a plain
         onpointerdown is delegated to the root and would run too late -->
    <button
      class="unschedule"
      title="unschedule — back to the backlog"
      aria-label="unschedule"
      onpointerdowncapture={(e) => {
        e.stopPropagation();
      }}
      onclick={() => {
        store.schedule(task.id, null, 0);
      }}>&times;</button
    >
  {/if}
</div>

<style>
  .scrap {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 3px 8px;
    font-size: 18px;
    line-height: 1.25;
    border-radius: 3px;
    cursor: grab;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    outline: none;
    transition: background 0.12s;
    -webkit-touch-callout: none;
  }

  .scrap:hover,
  .scrap:focus-visible {
    background: rgb(from var(--highlight) r g b / 55%);
  }

  .lifted {
    display: none;
  }

  .body {
    flex: 1;
    min-width: 0;
  }

  .done {
    color: var(--pencil);
  }

  .done .txt {
    background: linear-gradient(
      to top,
      transparent 44%,
      var(--accent) 44%,
      var(--accent) 52%,
      transparent 52%
    );
    opacity: 0.75;
  }

  .when {
    flex: none;
    font-size: 14px;
    color: var(--accent);
    opacity: 0.85;
  }

  .unschedule {
    flex: none;
    align-self: center;
    padding: 0 7px;
    font-size: 16px;
    line-height: 1.3;
    color: var(--pencil);
    background: transparent;
    border-color: transparent;
  }

  .unschedule:hover {
    color: var(--accent);
    border-color: var(--faint);
    background: #fff;
  }

  @media (width <= 700px) {
    .scrap {
      font-size: 17px;
      padding: 5px 8px;
    }
  }
</style>
