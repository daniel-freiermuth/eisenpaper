<script lang="ts">
  import { onMount, tick } from "svelte";

  import { drag } from "./drag.svelte";
  import type { Task } from "./model";
  import {
    addDays,
    backlog,
    dayHeading,
    dueLabel,
    overdue,
    tasksOn,
  } from "./schedule";
  import { store } from "./sheet.svelte";
  import TaskList from "./TaskList.svelte";
  import { today } from "./today.svelte";

  const WINDOW_DAYS = 7;
  /** hovering a paging button with a scrap turns the page this often */
  const HOVER_PAGE_MS = 650;

  /** first visible day, in days from today; the past is never shown */
  let offset = $state(0);
  /** phone only: the backlog tray is pulled up */
  let trayOpen = $state(false);
  let scroller: HTMLElement | undefined = $state();
  let overdueEl: HTMLElement | undefined = $state();
  /** overdue scraps are scrolled out of view above the backlog */
  let overdueHidden = $state(false);

  const days = $derived(
    Array.from({ length: WINDOW_DAYS }, (_, i) =>
      addDays(today.value, offset + i),
    ),
  );
  const late = $derived(overdue(store.sheet.tasks, today.value));
  const waiting = $derived(backlog(store.sheet.tasks));
  const range = $derived.by(() => {
    const first = dayHeading(days[0] ?? today.value, today.value).date;
    const last = dayHeading(days.at(-1) ?? today.value, today.value).date;
    return `${first} – ${last}`;
  });

  /** Turns the page by `step` days; the past stays out of view. */
  function page(step: number): void {
    offset = Math.max(0, offset + step);
  }

  function onNav(e: MouseEvent & { currentTarget: HTMLElement }): void {
    page(Number(e.currentTarget.dataset["nav"]));
  }

  /** Overdue sits above the backlog: start scrolled just past it. */
  async function showBacklog(): Promise<void> {
    await tick();
    if (scroller === undefined) return;
    scroller.scrollTop = overdueEl?.offsetHeight ?? 0;
    onscroll();
  }

  function onscroll(): void {
    overdueHidden =
      scroller !== undefined &&
      overdueEl !== undefined &&
      scroller.scrollTop > 8;
  }

  function toggleTray(): void {
    trayOpen = !trayOpen;
    if (trayOpen) void showBacklog();
  }

  onMount(() => void showBacklog());

  // drag a scrap onto a paging button and hold it there to turn the page
  $effect(() => {
    const nav = drag.current?.nav;
    if (nav === undefined || nav === null) return;
    const timer = setInterval(() => {
      page(Number(nav));
    }, HOVER_PAGE_MS);
    return () => {
      clearInterval(timer);
    };
  });

  // a scrap lifted from a day reaches the closed tray: open it as a target
  $effect(() => {
    if (drag.current?.zone === "backlog" && !trayOpen) trayOpen = true;
  });
</script>

<section class="schedule">
  <aside class="side" class:open={trayOpen}>
    <button
      class="handle"
      aria-expanded={trayOpen}
      onclick={toggleTray}
      data-zone="backlog"
    >
      <span class="grip"></span>
      backlog <b>{waiting.filter((t) => !t.done).length}</b>
      {#if late.length > 0}
        <span class="late">&middot; {late.length} overdue</span>
      {/if}
    </button>
    <div class="scroller" bind:this={scroller} {onscroll} data-autoscroll>
      {#if late.length > 0}
        <div class="overdue" bind:this={overdueEl} data-zone="overdue">
          <h3>overdue</h3>
          <TaskList
            zone="overdue"
            tasks={late}
            ordered={false}
            labelOf={(t: Task) => dueLabel(t.day ?? today.value, today.value)}
            unschedulable
          />
        </div>
      {/if}
      <div
        class="backlog"
        class:target={drag.current?.zone === "backlog"}
        data-zone="backlog"
      >
        <h3>backlog <small>most urgent &amp; important first</small></h3>
        <TaskList
          zone="backlog"
          tasks={waiting}
          ordered={false}
          empty="everything is scheduled"
        />
      </div>
    </div>
    {#if late.length > 0 && overdueHidden}
      <button
        class="peek"
        onclick={() => scroller?.scrollTo({ top: 0, behavior: "smooth" })}
        >&uarr; {late.length} overdue</button
      >
    {/if}
  </aside>

  <div class="main">
    <header class="nav">
      <button data-nav="-7" disabled={offset === 0} onclick={onNav}
        >&laquo;</button
      >
      <button data-nav="-1" disabled={offset === 0} onclick={onNav}
        >&lsaquo;</button
      >
      <button
        disabled={offset === 0}
        onclick={() => {
          offset = 0;
        }}>today</button
      >
      <button data-nav="1" onclick={onNav}>&rsaquo;</button>
      <button data-nav="7" onclick={onNav}>&raquo;</button>
      <span class="range">{range}</span>
    </header>

    <div class="days" data-autoscroll>
      {#each days as day (day)}
        {@const head = dayHeading(day, today.value)}
        <section
          class="day"
          class:today={day === today.value}
          class:weekend={head.weekend}
          class:target={drag.current?.zone === day}
          data-zone={day}
        >
          <h3>{head.name} <small>{head.date}</small></h3>
          <div class="day-list" data-autoscroll>
            <TaskList zone={day} tasks={tasksOn(store.sheet.tasks, day)} />
          </div>
        </section>
      {/each}
    </div>
  </div>
</section>

{#if drag.current}
  {@const d = drag.current}
  <div
    class="ghost"
    class:done={d.done}
    style:left="{d.x - d.grabX}px"
    style:top="{d.y - d.grabY}px"
    style:width="{d.width}px"
  >
    {d.text}
  </div>
{/if}

<style>
  .schedule {
    position: fixed;
    inset: 0 0 0 var(--tabs-w);
    display: grid;
    grid-template-columns: minmax(240px, 320px) 1fr;
  }

  h3 {
    margin: 0;
    padding: 6px 8px 2px;
    font-size: 19px;
    font-weight: normal;
    color: var(--pencil);
    letter-spacing: 0.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .backlog h3 small {
    display: block;
  }

  h3 small {
    font-size: 14px;
    color: var(--faint);
  }

  /* ---- backlog column ---- */

  .side {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1.5px solid rgb(from var(--pencil) r g b / 45%);
    background: rgb(255 255 255 / 22%);
  }

  .handle {
    display: none;
  }

  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
    padding: 6px 6px 40vh; /* room to scroll the overdue block away */
  }

  .overdue {
    padding-bottom: 6px;
    margin-bottom: 8px;
    border-bottom: 1.5px dashed rgb(from var(--accent) r g b / 50%);
  }

  .overdue h3 {
    color: var(--accent);
  }

  .backlog {
    min-height: 100%;
    border-radius: 6px;
    transition: background 0.12s;
  }

  .peek {
    position: absolute;
    top: 8px;
    right: 10px;
    transform: rotate(-1deg);
    color: var(--accent);
    box-shadow: 1px 2px 6px rgb(43 42 38 / 15%);
  }

  /* ---- days ---- */

  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    container-type: inline-size;
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px 12px 6px;
  }

  .nav button {
    min-width: 34px;
  }

  .nav button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .range {
    margin-left: 8px;
    color: var(--pencil);
    font-size: 16px;
  }

  .days {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    touch-action: pan-y;
    padding: 0 12px 24px;
  }

  .day {
    border-top: 1.5px solid rgb(from var(--pencil) r g b / 40%);
    padding-bottom: 10px;
    min-height: 72px;
    border-radius: 2px;
    transition: background 0.12s;
  }

  .weekend {
    background: rgb(from var(--faint) r g b / 9%);
  }

  .today h3 {
    color: var(--ink);
    text-decoration: underline var(--accent) 2px;
    text-underline-offset: 4px;
  }

  .target {
    background: rgb(from var(--highlight) r g b / 40%);
  }

  /* wide: a week planner, one column per day */
  @container (width >= 900px) {
    .days {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      overflow: hidden;
      padding-bottom: 0;
    }

    .day {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-top: none;
      border-left: 1.5px solid rgb(from var(--pencil) r g b / 30%);
      padding: 0 2px;
    }

    .day:first-child {
      border-left: none;
    }

    .day h3 {
      border-bottom: 1.5px solid rgb(from var(--pencil) r g b / 40%);
      margin-bottom: 4px;
    }

    .day-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      touch-action: pan-y;
      padding-bottom: 24px;
    }
  }

  /* ---- drag ghost ---- */

  .ghost {
    position: fixed;
    z-index: 50;
    padding: 3px 8px;
    font-size: 18px;
    line-height: 1.25;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    pointer-events: none;
    background: rgb(from var(--highlight) r g b / 90%);
    border-radius: 3px;
    box-shadow: 2px 4px 12px rgb(43 42 38 / 22%);
    transform: rotate(-1.5deg);
    cursor: grabbing;
  }

  .ghost.done {
    color: var(--pencil);
    text-decoration: line-through var(--accent);
  }

  /* ---- phone: days fill the screen, backlog is a pull-up tray ---- */

  @media (width <= 700px) {
    .schedule {
      display: flex;
      flex-direction: column;
    }

    .main {
      flex: 1;
      order: 0;
    }

    .nav {
      padding-top: 46px; /* clear the toolbar */
    }

    .side {
      order: 1;
      flex: none;
      height: 46px;
      border-right: none;
      border-top: 1.5px solid rgb(from var(--pencil) r g b / 55%);
      background: #efe9d8;
      box-shadow: 0 -4px 14px rgb(43 42 38 / 10%);
      transition: height 0.2s ease;
    }

    .side.open {
      height: 46vh;
    }

    .handle {
      display: flex;
      flex: none;
      align-items: center;
      gap: 6px;
      height: 44px;
      padding: 0 14px;
      border: none;
      border-radius: 0;
      background: transparent;
      font-size: 17px;
      color: var(--pencil);
    }

    .grip {
      width: 28px;
      height: 4px;
      margin-right: 6px;
      border-radius: 2px;
      background: var(--faint);
    }

    .late {
      color: var(--accent);
    }

    .side:not(.open) .scroller,
    .side:not(.open) .peek {
      visibility: hidden;
    }

    .peek {
      top: 52px;
    }
  }
</style>
