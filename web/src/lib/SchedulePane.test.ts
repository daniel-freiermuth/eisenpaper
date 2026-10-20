// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { drag, type Lifted } from "./drag.svelte";
import type { Task } from "./model";
import { addDays, tasksOn } from "./schedule";
import SchedulePane from "./SchedulePane.svelte";
import { store } from "./sheet.svelte";
import { today } from "./today.svelte";

// SchedulePane is the real host: each TaskList gets its zone and tasks from
// the pane, so the slot and the drop routing are exercised the way the app
// wires them. Driving `drag.current` directly stands in for hitTest, which
// needs real layout; the pointer tests below stub only `elementFromPoint`.
const TODAY = "2026-10-20";
const TOMORROW = addDays(TODAY, 1);
const PAST = addDays(TODAY, -2);

let pane: Record<string, unknown>;
let commit: MockInstance<() => void>;
let realToday: string;

const scrap = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: `task ${id}`,
  x: 0.5,
  y: 0.5,
  done: false,
  created: 1,
  ...over,
});

/** a, b, c on today; x on tomorrow; one overdue; two open + one done in the backlog. */
const sheet = (): Task[] => [
  scrap("a", { day: TODAY, order: 0 }),
  scrap("b", { day: TODAY, order: 1 }),
  scrap("c", { day: TODAY, order: 2 }),
  scrap("x", { day: TOMORROW, order: 0 }),
  scrap("late", { day: PAST, order: 0 }),
  scrap("open1", { x: 0.9, y: 0.1 }),
  scrap("open2"),
  scrap("gone", { done: true }),
];

/**
 * Lifts `id` over `zone` at `index`; called again for the same scrap it
 * moves the pointer instead. Like drag.svelte.ts, it assigns `drag.current`
 * once per lift and then mutates it in place, as hitTest does.
 */
function lift(
  id: string,
  zone: string | null,
  index = 0,
  nav: string | null = null,
): void {
  const d = drag.current;
  if (d !== null) {
    if (d.id !== id) throw new Error(`${d.id} is already lifted`);
    Object.assign(d, { zone, index, nav });
    flushSync();
    return;
  }
  const task = store.sheet.tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  const lifted: Lifted = {
    id,
    text: task.text,
    done: task.done,
    x: 0,
    y: 0,
    grabX: 0,
    grabY: 0,
    width: 100,
    zone,
    index,
    nav,
  };
  drag.current = lifted;
  flushSync();
}

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

/** The list a zone renders: ids, `id*` for the lifted scrap, `|` for the slot. */
function layout(zone: string): string[] {
  return Array.from(el(`[data-zone="${zone}"] .list`).children, (child) => {
    if (!(child instanceof HTMLElement)) return "?";
    if (child.classList.contains("slot")) return "|";
    if (child.classList.contains("empty")) return `(${child.textContent})`;
    const id = child.dataset["id"] ?? "?";
    return child.classList.contains("lifted") ? `${id}*` : id;
  });
}

/** Where the scrap lands if dropped now, read off the drawn slot. */
function landing(zone: string): string[] {
  const rows = layout(zone);
  const lifted = drag.current?.id ?? "";
  return rows
    .filter((r) => r !== `${lifted}*`)
    .map((r) => (r === "|" ? lifted : r));
}

const dayIds = (day: string): string[] =>
  tasksOn(store.sheet.tasks, day).map((t) => t.id);

function navButton(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".nav button"),
  ).find((b) => b.textContent.trim() === label);
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
}

const shownDays = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(".days [data-zone]"),
    (s) => s.dataset["zone"] ?? "",
  );

beforeEach(() => {
  realToday = today.value;
  today.value = TODAY;
  store.cancelEdit();
  store.sheet = { tasks: sheet(), archive: [] };
  // persistence is SheetStore's concern (sheet.svelte.test.ts)
  commit = vi.spyOn(store, "commit").mockImplementation(() => undefined);
  pane = mount(SchedulePane, { target: document.body });
  flushSync();
});

afterEach(() => {
  drag.current = null;
  flushSync();
  void unmount(pane);
  today.value = realToday;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TaskList drop slot", () => {
  it("keeps the lifted row mounted but numbers the slot among the others", () => {
    lift("a", TODAY, 0);
    expect(layout(TODAY)).toEqual(["a*", "|", "b", "c"]);
    lift("a", TODAY, 1);
    expect(layout(TODAY)).toEqual(["a*", "b", "|", "c"]);
    lift("a", TODAY, 2);
    expect(layout(TODAY)).toEqual(["a*", "b", "c", "|"]);
  });

  it.each([0, 1, 2])(
    "draws the slot where placeTask puts a same-day reorder (index %i)",
    (index) => {
      lift("b", TODAY, index);
      const drawn = landing(TODAY);
      drag.current = null;

      store.schedule("b", TODAY, index);

      expect(dayIds(TODAY)).toEqual(drawn);
    },
  );

  it.each([0, 1, 2, 3])(
    "draws the slot where placeTask puts a scrap from another day (index %i)",
    (index) => {
      lift("x", TODAY, index);
      const drawn = landing(TODAY);
      drag.current = null;

      store.schedule("x", TODAY, index);

      expect(dayIds(TODAY)).toEqual(drawn);
    },
  );

  it("puts the slot after the last row when the index equals the row count", () => {
    lift("x", TODAY, 3);
    expect(layout(TODAY)).toEqual(["a", "b", "c", "|"]);
  });

  it("opens a slot on an empty day, and only on the hovered day", () => {
    const empty = addDays(TODAY, 2);
    lift("a", empty, 0);
    expect(layout(empty)).toEqual(["|"]);
    expect(layout(TODAY)).toEqual(["a*", "b", "c"]);
    expect(layout(TOMORROW)).toEqual(["x"]);
  });

  it("never draws a slot in the unordered backlog or overdue lists", () => {
    lift("a", "backlog", 0);
    expect(layout("backlog")).toEqual(["open1", "open2", "gone"]);
    lift("a", "overdue", 0);
    expect(layout("overdue")).toEqual(["late"]);
  });

  it("shows the backlog's empty message once its only scrap is lifted", () => {
    store.sheet = {
      tasks: [scrap("only"), scrap("a", { day: TODAY, order: 0 })],
      archive: [],
    };
    flushSync();
    expect(layout("backlog")).toEqual(["only"]);

    lift("only", TODAY, 1);
    expect(layout("backlog")).toEqual(["only*", "(everything is scheduled)"]);
  });
});

describe("ScheduleItem drop routing", () => {
  let schedule: MockInstance<typeof store.schedule>;
  let under: HTMLElement | null;

  beforeEach(() => {
    schedule = vi.spyOn(store, "schedule");
    under = null;
    vi.spyOn(document, "elementFromPoint").mockImplementation(() => under);
  });

  const pointer = (type: string, y: number): PointerEvent =>
    new PointerEvent(type, {
      clientX: 0,
      clientY: y,
      button: 0,
      pointerType: "mouse",
      bubbles: true,
    });

  /**
   * Mouse-drags `id` and releases it over `target` at height `y`. happy-dom
   * lays every scrap out as a zero rect, so y < 0 is above all of them
   * (index 0) and y > 0 below all of them (index = the other scraps).
   */
  function dragOnto(id: string, target: HTMLElement, y: number): void {
    el(`[data-id="${id}"]`).dispatchEvent(pointer("pointerdown", 0));
    under = target;
    dispatchEvent(pointer("pointermove", y)); // past the threshold: lift
    dispatchEvent(pointer("pointermove", y)); // the lifted scrap follows
    flushSync();
    expect(drag.current?.id).toBe(id);
    dispatchEvent(pointer("pointerup", y));
    flushSync();
  }

  it("schedules onto a day at the index under the pointer", () => {
    dragOnto("x", el(`[data-zone="${TODAY}"]`), -10);
    expect(schedule).toHaveBeenCalledExactlyOnceWith("x", TODAY, 0);
    expect(dayIds(TODAY)).toEqual(["x", "a", "b", "c"]);

    dragOnto("a", el(`[data-zone="${TODAY}"]`), 10);
    // the lifted scrap is not counted: the end of the day is index 3
    expect(schedule).toHaveBeenLastCalledWith("a", TODAY, 3);
    expect(dayIds(TODAY)).toEqual(["x", "b", "c", "a"]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("unschedules a drop on the backlog tray handle", () => {
    dragOnto("a", el("button.handle"), 10);
    expect(schedule).toHaveBeenCalledExactlyOnceWith("a", null, 0);
    expect(store.sheet.tasks.find((t) => t.id === "a")?.day).toBeUndefined();
  });

  it("ignores a drop on the overdue list", () => {
    dragOnto("a", el('[data-zone="overdue"]'), 10);
    expect(schedule).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(dayIds(TODAY)).toEqual(["a", "b", "c"]);
  });

  it("ignores a release outside every zone", () => {
    dragOnto("a", document.body, 10);
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("SchedulePane paging", () => {
  const week = (from: number): string[] =>
    Array.from({ length: 7 }, (_, i) => addDays(TODAY, from + i));

  it("starts on today with every way back disabled", () => {
    expect(shownDays()).toEqual(week(0));
    for (const label of ["«", "‹", "today"])
      expect(navButton(label).disabled).toBe(true);
    for (const label of ["›", "»"])
      expect(navButton(label).disabled).toBe(false);
  });

  it("moves by a day or a week and returns with today", () => {
    navButton("»").click();
    flushSync();
    expect(shownDays()).toEqual(week(7));
    navButton("›").click();
    flushSync();
    expect(shownDays()).toEqual(week(8));
    for (const label of ["«", "‹", "today"])
      expect(navButton(label).disabled).toBe(false);

    navButton("today").click();
    flushSync();
    expect(shownDays()).toEqual(week(0));
  });

  it("clamps a week back from tomorrow to today, never the past", () => {
    navButton("›").click();
    flushSync();
    navButton("«").click();
    flushSync();
    expect(shownDays()).toEqual(week(0));
    expect(navButton("«").disabled).toBe(true);
  });

  it("turns a page per hover tick and stops at today", () => {
    vi.useFakeTimers();
    navButton("»").click();
    navButton("›").click();
    flushSync();
    expect(shownDays()).toEqual(week(8));

    lift("a", null, 0, "-7");
    vi.advanceTimersByTime(650);
    flushSync();
    expect(shownDays()).toEqual(week(1));
    vi.advanceTimersByTime(650 * 3);
    flushSync();
    expect(shownDays()).toEqual(week(0));
  });
});

describe("SchedulePane backlog tray", () => {
  const handle = (): HTMLElement => el("button.handle");

  it("counts only the open backlog scraps", () => {
    expect(handle().querySelector("b")?.textContent).toBe("2");
  });

  it("opens the closed tray when a lifted scrap reaches the backlog", () => {
    expect(handle().getAttribute("aria-expanded")).toBe("false");

    lift("a", TOMORROW, 0);
    expect(handle().getAttribute("aria-expanded")).toBe("false");

    lift("a", "backlog", 0);
    expect(handle().getAttribute("aria-expanded")).toBe("true");
  });
});
