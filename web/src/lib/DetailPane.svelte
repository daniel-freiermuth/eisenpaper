<script lang="ts">
  import { drag } from "./drag.svelte";
  import { addDays, dueLabel } from "./schedule";
  import { store } from "./sheet.svelte";
  import { today } from "./today.svelte";

  const task = $derived(store.selected);
  const open = $derived(task !== undefined);

  const QUICK: { label: string; days: number }[] = [
    { label: "today", days: 0 },
    { label: "tomorrow", days: 1 },
    { label: "next week", days: 7 },
  ];

  /** a day, or null for the backlog; scheduled days go to the end of their list */
  function scheduleOn(day: string | null): void {
    if (task === undefined) return;
    store.schedule(task.id, day, Infinity);
  }

  function onwindowkeydown(e: KeyboardEvent): void {
    // Escape belongs to an inline edit or a drag while one is running
    if (
      e.key === "Escape" &&
      open &&
      store.editingId === null &&
      drag.current === null
    )
      store.select(null);
  }

  function tearOff(): void {
    if (task !== undefined && confirm(`tear off "${task.text}"?`))
      store.remove(task);
  }
</script>

<svelte:window onkeydown={onwindowkeydown} />

<aside class:open aria-hidden={!open} inert={!open} aria-label="task details">
  {#if task !== undefined}
    <button
      class="close"
      aria-label="close"
      onclick={() => {
        store.select(null);
      }}>&times;</button
    >
    <h2 class:done={task.done}><span class="txt">{task.text}</span></h2>
    <div class="row">
      <button
        onclick={() => {
          store.toggleDone(task);
        }}>{task.done ? "↺ uncross" : "✓ cross out"}</button
      >
      <button class="danger" onclick={tearOff}>tear off</button>
    </div>

    <section>
      <h3>
        <label for="detail-day">scheduled</label>
        <small
          >{task.day === undefined
            ? "in the backlog"
            : dueLabel(task.day, today.value)}</small
        >
      </h3>
      <div class="row">
        {#each QUICK as q (q.label)}
          {@const day = addDays(today.value, q.days)}
          <button
            class:active={task.day === day}
            onclick={() => {
              scheduleOn(day);
            }}>{q.label}</button
          >
        {/each}
        <button
          class:active={task.day === undefined}
          onclick={() => {
            scheduleOn(null);
          }}>backlog</button
        >
      </div>
      <div class="row">
        <input
          id="detail-day"
          type="date"
          min={today.value}
          value={task.day ?? ""}
          onchange={(e) => {
            const day = e.currentTarget.value;
            scheduleOn(day === "" ? null : day);
          }}
        />
      </div>
    </section>

    <section class="grow">
      <h3><label for="detail-note">notes</label></h3>
      <textarea
        id="detail-note"
        placeholder="anything worth remembering…"
        value={task.note ?? ""}
        oninput={(e) => {
          store.setNote(task, e.currentTarget.value);
        }}></textarea>
    </section>
  {/if}
</aside>

<style>
  aside {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--detail-w);
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: #efe9d8;
    border-left: 2px solid var(--faint);
    box-shadow: -4px 0 18px rgb(43 42 38 / 15%);
    transform: translateX(105%);
    transition: transform 0.2s ease;
    z-index: 28; /* under the archive panel */
    padding: 18px;
    overflow-y: auto;
  }

  .open {
    transform: none;
  }

  h2 {
    margin: 0 28px 0 0;
    font-size: 22px;
    font-weight: normal;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  h2.done {
    color: var(--pencil);
  }

  h2.done .txt {
    text-decoration: line-through var(--accent) 2px;
  }

  h3 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: normal;
    color: var(--pencil);
  }

  h3 small {
    margin-left: 6px;
    color: var(--ink);
  }

  section {
    border-top: 1px dashed var(--faint);
    padding-top: 8px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .active {
    border-color: var(--pencil);
    background: rgb(from var(--highlight) r g b / 90%);
  }

  .danger:hover {
    color: var(--accent);
  }

  .grow {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 160px;
  }

  textarea {
    flex: 1;
    resize: none;
    line-height: 1.35;
  }

  .close {
    position: absolute;
    top: 14px;
    right: 14px;
    padding: 0 8px;
    font-size: 18px;
  }
</style>
