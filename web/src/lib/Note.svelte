<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  import { rotation, type Task } from "./model";
  import { dueLabel } from "./schedule";
  import { store } from "./sheet.svelte";
  import { tintStyle } from "./tint";
  import { today } from "./today.svelte";

  interface Props {
    task: Task;
    editing: boolean;
  }
  const { task, editing }: Props = $props();

  const project = $derived(
    store.sheet.projects?.find((p) => p.id === task.project),
  );
  /** colours for every state, as --t-* custom properties */
  const tintVars = $derived(tintStyle(project?.color));

  /** below this a press counts as a click, not a drag */
  const DRAG_THRESHOLD_PX = 6;
  /** delay so a double-click (edit) can cancel the single-click (select):
      selecting opens the detail pane, which on wide screens narrows this
      pane and slides the note away from under the second click. Browsers
      fire dblclick within the OS double-click time, 400ms by default on
      GNOME and 500ms on Windows, so wait out the longest default */
  const CLICK_DELAY_MS = 500;

  /** pointer, card position and pane size at press time; the card moves by the pointer's delta */
  let press: {
    x: number;
    y: number;
    taskX: number;
    taskY: number;
    paneW: number;
    paneH: number;
    moved: boolean;
  } | null = null;
  let dragging = $state(false);
  let cancelled = false;

  // fill, focus and put the caret at the end when entering edit mode
  const focusAtEnd: Attachment<HTMLElement> = (el) => {
    el.innerText = task.text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };

  function onpointerdown(e: PointerEvent): void {
    if (e.button !== 0 || editing) return;
    const el = e.currentTarget as HTMLElement;
    const pane = el.offsetParent ?? document.documentElement;
    press = {
      x: e.clientX,
      y: e.clientY,
      taskX: task.x,
      taskY: task.y,
      paneW: pane.clientWidth,
      paneH: pane.clientHeight,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  }

  function onpointermove(e: PointerEvent): void {
    if (press === null) return;
    if (
      !press.moved &&
      Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX
    )
      return;
    press.moved = true;
    dragging = true;
    store.move(
      task,
      press.taskX + (e.clientX - press.x) / press.paneW,
      press.taskY + (e.clientY - press.y) / press.paneH,
    );
  }

  function onpointerup(): void {
    if (press === null) return;
    const { moved } = press;
    press = null;
    dragging = false;
    if (moved) {
      store.commit();
      return;
    }
    store.selectLater(task.id, CLICK_DELAY_MS);
  }

  // the browser took the pointer (a scroll, a palm, a system gesture): no
  // pointerup follows, so abort the drag and put the note back. A save or
  // pull landing mid-drag may have cached or pushed the live position, so
  // commit the note back too; with nothing stored mid-drag it saves nothing
  function onpointercancel(): void {
    if (press === null) return;
    if (press.moved) {
      store.move(task, press.taskX, press.taskY);
      store.commit();
    }
    press = null;
    dragging = false;
  }

  function ondblclick(e: MouseEvent): void {
    e.stopPropagation(); // the pane would create a new note
    if (editing) return; // a double-click in the text selects a word
    store.cancelSelect();
    store.startEdit(task);
  }

  function oncontextmenu(e: MouseEvent): void {
    if (editing) return; // the text field's own menu: paste, spelling
    e.preventDefault();
    if (confirm(`tear off "${task.text}"?`)) store.remove(task);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (editing || e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      store.startEdit(task);
    } else if (e.key === " ") {
      e.preventDefault();
      store.toggleDone(task);
    } else if (e.key === "Delete") {
      e.preventDefault();
      if (confirm(`tear off "${task.text}"?`)) store.remove(task);
    }
  }

  function onEditKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation(); // the blur ends the edit; the note would restart it
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the blur ends the edit; the detail pane would close
      cancelled = true;
      (e.currentTarget as HTMLElement).blur();
    }
  }

  function onblur(e: FocusEvent): void {
    if (cancelled) {
      cancelled = false;
      store.cancelEdit();
    } else {
      store.finishEdit(task, (e.currentTarget as HTMLElement).innerText);
    }
  }
</script>

<div
  class="note"
  class:done={task.done}
  class:dragging
  class:editing
  class:selected={store.selectedId === task.id}
  class:tinted={tintVars !== undefined}
  class:check-left={task.x > 0.5}
  style={tintVars}
  style:left="{task.x * 100}%"
  style:top="{task.y * 100}%"
  style:--rot={rotation(task.id)}
  role="button"
  tabindex="0"
  aria-pressed={task.done}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  {onpointercancel}
  {ondblclick}
  {oncontextmenu}
  {onkeydown}
>
  {#if editing}
    <span
      class="txt"
      contenteditable="plaintext-only"
      role="textbox"
      tabindex="0"
      aria-multiline="true"
      aria-label="task text"
      onkeydown={onEditKeydown}
      {onblur}
      {@attach focusAtEnd}
    ></span>
  {:else}
    <span class="txt">{task.text}</span>
    {#if project !== undefined}
      <span class="project" title="project">{project.name}</span>
    {/if}
    {#if task.day !== undefined}
      <span
        class="when"
        class:late={!task.done && task.day < today.value}
        title="scheduled {task.day}">{dueLabel(task.day, today.value)}</span
      >
    {/if}
    <button
      class="check"
      title={task.done ? "uncross" : "cross out"}
      aria-label={task.done ? "uncross" : "cross out"}
      onpointerdown={(e) => {
        e.stopPropagation(); // neither a drag nor a selection
      }}
      ondblclick={(e) => {
        e.stopPropagation();
      }}
      onclick={() => {
        store.toggleDone(task);
      }}>{task.done ? "↺" : "✓"}</button
    >
  {/if}
</div>

<style>
  .note {
    position: absolute;
    transform: translate(-50%, -50%) rotate(var(--rot, 0deg));
    /* size to the words, not to the room left before the pane's edge */
    width: max-content;
    max-width: 34ch;
    padding: 2px 8px;
    font-size: 19px;
    line-height: 1.25;
    cursor: grab;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    border-radius: 3px;
    transition: background 0.12s;
    outline: none;
  }

  .note:hover,
  .note:focus-visible {
    background: rgb(from var(--highlight) r g b / 55%);
  }

  .dragging {
    cursor: grabbing;
    opacity: 0.85;
    z-index: 10;
    background: rgb(from var(--highlight) r g b / 75%);
    box-shadow: 2px 3px 8px rgb(43 42 38 / 18%);
  }

  .selected {
    z-index: 4;
    background: rgb(from var(--highlight) r g b / 80%);
    box-shadow: 0 0 0 1.5px var(--pencil);
  }

  /* above overlapping neighbours, so they cannot steal the way to ✓ */
  .note:hover {
    z-index: 5;
  }

  /* a coloured project tints the scrap with one background per look (open,
     crossed out) and text colours tint.ts picked to read on it. Hover draws
     a lift shadow; selection swaps to a background tint.ts moved away from
     the text colour, so the text keeps its colours and only gains contrast. */
  .note.tinted {
    --fg: var(--t-open-fg);
    --muted: var(--t-open-muted);
    --selected: var(--t-open-selected);
    background: var(--t-open-bg);
    color: var(--fg);
  }

  /* crossed-out words take the muted colour */
  .note.tinted.done {
    --fg: var(--t-done-muted);
    --muted: var(--t-done-muted);
    --selected: var(--t-done-selected);
    background: var(--t-done-bg);
  }

  .note.tinted.selected {
    background: var(--selected);
    box-shadow: inset 0 0 0 1.5px var(--fg);
  }

  .tinted:hover,
  .tinted:focus-visible {
    box-shadow: 0 2px 7px rgb(43 42 38 / 35%);
  }

  .tinted .project,
  .tinted .when {
    color: var(--muted);
  }

  /* no red text reads at every tint (mid-tones defeat any hue), so on a
     tint an overdue date becomes a red chip carrying its own contrast */
  .tinted .when.late {
    padding: 0 4px;
    border-radius: 3px;
    color: #fff;
    background: var(--accent);
  }

  /* the computed muted colour already fades it; opacity would undo the
     contrast guarantee */
  .tinted.done .txt {
    opacity: 1;
  }

  /* hangs off the edge facing the middle of the pane (right in the left
     half, left in the right half), so a note near either edge cannot push
     it off-screen or under the detail pane; as a child it keeps the note
     hovered */
  .check {
    position: absolute;
    top: 50%;
    left: 100%;
    transform: translateY(-50%);
    /* linger after the pointer leaves, so a sloppy path still reaches it */
    transition: visibility 0s linear 0.35s;
  }

  .check-left .check {
    left: auto;
    right: 100%;
  }

  /* invisible bridge from the note to ✓ over the full note height; painted
     before the button, so the button stays on top for clicks */
  .note:is(:hover, .selected)::before {
    content: "";
    position: absolute;
    top: -6px;
    bottom: -6px;
    left: 100%;
    width: 32px;
  }

  .check-left:is(:hover, .selected)::before {
    left: auto;
    right: 100%;
  }

  .note:is(:hover, :focus-within, .selected) .check {
    transition-delay: 0s;
  }

  .note:not(:hover, :focus-within, .selected) .check {
    visibility: hidden;
  }

  .project,
  .when {
    margin-left: 6px;
    font-size: 13px;
    color: var(--pencil);
    white-space: nowrap;
  }

  .project::before {
    content: "#";
  }

  .late {
    color: var(--accent);
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

  .editing {
    cursor: text;
    min-width: 6ch;
    background: rgb(from var(--highlight) r g b / 80%);
    outline: 1.5px dashed var(--pencil);
  }

  .txt {
    outline: none;
  }

  @media (width <= 700px) {
    .note {
      font-size: 17px;
      max-width: 26ch;
    }
  }
</style>
