<script lang="ts">
  import { drag, draggable } from "./drag.svelte";
  import type { Task } from "./model";
  import { store } from "./sheet.svelte";
  import { tintStyle } from "./tint";

  interface Props {
    task: Task;
    /** shown after the text, e.g. the day an overdue task was due */
    label?: string | undefined;
    /** offer a button that sends the task back to the backlog */
    unschedulable?: boolean;
  }
  const { task, label, unschedulable = false }: Props = $props();

  const project = $derived(
    store.sheet.projects?.find((p) => p.id === task.project),
  );
  /** colours for every state, as --t-* custom properties */
  const tintVars = $derived(tintStyle(project?.color));

  /** buttons inside the scrap must neither lift it nor select it */
  const stop = (e: Event): void => {
    e.stopPropagation();
  };

  function onDrop(zone: string, index: number): void {
    if (zone === "overdue") return; // past days are not a target
    store.schedule(task.id, zone === "backlog" ? null : zone, index);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.target !== e.currentTarget) return; // a button inside handles its own
    if (e.key === " ") {
      e.preventDefault();
      store.toggleDone(task);
    } else if (e.key === "Enter") {
      e.preventDefault();
      store.select(task.id);
    }
  }
</script>

<div
  class="scrap"
  class:done={task.done}
  class:lifted={drag.current?.id === task.id}
  class:selected={store.selectedId === task.id}
  class:tinted={tintVars !== undefined}
  style={tintVars}
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
      store.select(task.id);
    },
    onDrop,
  })}
>
  <!-- the inline span keeps the strike-through to the words, line by line -->
  <span class="body"><span class="txt">{task.text}</span></span>
  {#if project !== undefined}
    <span class="project" title="project">{project.name}</span>
  {/if}
  {#if label !== undefined}
    <span class="when">{label}</span>
  {/if}
  <button
    class="check"
    title={task.done ? "uncross" : "cross out"}
    aria-label={task.done ? "uncross" : "cross out"}
    onpointerdown={stop}
    onclick={() => {
      store.toggleDone(task);
    }}>{task.done ? "↺" : "✓"}</button
  >
  {#if unschedulable}
    <button
      class="unschedule"
      title="unschedule — back to the backlog"
      aria-label="unschedule"
      onpointerdown={stop}
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

  .selected {
    background: rgb(from var(--highlight) r g b / 80%);
    box-shadow: inset 0 0 0 1.5px var(--pencil);
  }

  /* see Note.svelte: one background per look; hover draws a lift shadow,
     selection a background moved away from the text colour */
  .scrap.tinted {
    --fg: var(--t-open-fg);
    --muted: var(--t-open-muted);
    --selected: var(--t-open-selected);
    background: var(--t-open-bg);
    color: var(--fg);
  }

  .scrap.tinted.done {
    --fg: var(--t-done-muted);
    --muted: var(--t-done-muted);
    --selected: var(--t-done-selected);
    background: var(--t-done-bg);
  }

  .scrap.tinted.selected {
    background: var(--selected);
    box-shadow: inset 0 0 0 1.5px var(--fg);
  }

  .tinted:hover,
  .tinted:focus-visible {
    box-shadow: 0 2px 7px rgb(43 42 38 / 35%);
  }

  /* the computed colours already carry the fading; opacity would undo
     their contrast guarantee */
  .tinted .project,
  .tinted .unschedule {
    color: var(--muted);
  }

  /* see Note.svelte: on a tint the overdue date is a red chip */
  .tinted .when {
    padding: 0 4px;
    border-radius: 3px;
    color: #fff;
    background: var(--accent);
    opacity: 1;
  }

  .tinted.done .txt {
    opacity: 1;
  }

  .check {
    align-self: center;
    width: 22px;
    height: 22px;
    font-size: 13px;
  }

  .scrap:not(:hover, :focus-within, .selected) .check {
    visibility: hidden;
  }

  .project {
    flex: none;
    font-size: 14px;
    color: var(--pencil);
  }

  .project::before {
    content: "#";
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
