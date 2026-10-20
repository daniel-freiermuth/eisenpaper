// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drag } from "./drag.svelte";
import { addDays } from "./schedule";
import SchedulePane from "./SchedulePane.svelte";
import { store } from "./sheet.svelte";
import { today } from "./today.svelte";

// SchedulePane is the real host: an overdue scrap shows both the ✓ and the
// × button, and the app root delegates events as it does in the app.
let pane: Record<string, unknown>;

function task() {
  const t = store.sheet.tasks[0];
  if (t === undefined) throw new Error("no task on the sheet");
  return t;
}

function button(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `.scrap button[aria-label="${label}"]`,
  );
  if (el === null) throw new Error(`no ${label} button rendered`);
  return el;
}

function pointer(el: HTMLElement, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: x,
      clientY: y,
      bubbles: true,
    }),
  );
  flushSync();
}

beforeEach(() => {
  store.select(null);
  store.sheet = {
    tasks: [
      {
        id: "t1",
        text: "file tax return",
        x: 0.5,
        y: 0.5,
        done: false,
        created: 1,
        day: addDays(today.value, -3),
      },
    ],
    archive: [],
  };
  vi.spyOn(store, "commit").mockImplementation(() => undefined);
  pane = mount(SchedulePane, { target: document.body });
  flushSync();
});

afterEach(() => {
  void unmount(pane);
  vi.restoreAllMocks();
});

describe("ScheduleItem buttons", () => {
  it("✓ crosses the task out without selecting the scrap", () => {
    const b = button("cross out");
    pointer(b, "pointerdown", 10, 10);
    pointer(b, "pointerup", 10, 10);
    b.click();
    flushSync();

    expect(task().done).toBe(true);
    expect(store.selectedId).toBeNull();
  });

  it("× unschedules the task without selecting the scrap", () => {
    const b = button("unschedule");
    pointer(b, "pointerdown", 10, 10);
    pointer(b, "pointerup", 10, 10);
    b.click();
    flushSync();

    expect(task().day).toBeUndefined();
    expect(store.selectedId).toBeNull();
  });

  it("a drag that starts on a button does not lift the scrap", () => {
    const b = button("unschedule");
    pointer(b, "pointerdown", 10, 10);
    pointer(b, "pointermove", 40, 40);

    expect(drag.current).toBeNull();
    pointer(b, "pointerup", 40, 40);
  });
});
