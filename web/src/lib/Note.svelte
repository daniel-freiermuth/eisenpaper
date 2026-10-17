<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  import { rotation, type Task } from "./model";
  import { dueLabel } from "./schedule";
  import { store } from "./sheet.svelte";
  import { today } from "./today.svelte";

  interface Props {
    task: Task;
    editing: boolean;
  }
  const { task, editing }: Props = $props();

  /** delay so a double-click (edit) can cancel the single-click (cross out) */
  const CLICK_DELAY_MS = 260;
  /** below this a press counts as a click, not a drag */
  const DRAG_THRESHOLD_PX = 6;

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
  let clickTimer: number | undefined;
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
    clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => {
      store.toggleDone(task);
    }, CLICK_DELAY_MS);
  }

  function ondblclick(e: MouseEvent): void {
    e.stopPropagation(); // the pane would create a new note
    clearTimeout(clickTimer);
    store.startEdit(task);
  }

  function oncontextmenu(e: MouseEvent): void {
    e.preventDefault();
    if (confirm(`tear off "${task.text}"?`)) store.remove(task);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (editing) return;
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
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
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
  style:left="{task.x * 100}%"
  style:top="{task.y * 100}%"
  style:--rot={rotation(task.id)}
  role="button"
  tabindex="0"
  aria-pressed={task.done}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
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
    {#if task.day !== undefined}
      <span
        class="when"
        class:late={!task.done && task.day < today.value}
        title="scheduled {task.day}">{dueLabel(task.day, today.value)}</span
      >
    {/if}
  {/if}
</div>

<style>
  .note {
    position: absolute;
    transform: translate(-50%, -50%) rotate(var(--rot, 0deg));
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

  .when {
    margin-left: 6px;
    font-size: 13px;
    color: var(--pencil);
    white-space: nowrap;
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
