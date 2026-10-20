// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drag } from "./drag.svelte";
import SchedulePane from "./SchedulePane.svelte";
import { store } from "./sheet.svelte";
import { today } from "./today.svelte";

// SchedulePane is the real host: both its `.days` column and every day's
// `.day-list` carry `data-autoscroll`, and which of them actually scrolls
// depends on the layout. happy-dom has no layout, so the geometry a browser
// would compute is stubbed per element below.
let pane: Record<string, unknown>;

/** the bottom-most visible day's scrap, sitting in `.days`' bottom edge band */
const OVER = { x: 300, y: 580 };

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector} rendered`);
  return found;
}

function layout(
  target: HTMLElement,
  rect: { top: number; bottom: number },
  scrollHeight: number,
): void {
  const height = rect.bottom - rect.top;
  let scrollTop = 0;
  Object.defineProperties(target, {
    clientHeight: { value: height, configurable: true },
    scrollHeight: { value: scrollHeight, configurable: true },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.max(0, Math.min(v, scrollHeight - height));
      },
    },
  });
  target.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: rect.top, width: 600, height });
}

function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
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

/** Lifts the backlog scrap and holds it over the scheduled one. */
function holdOverScheduledScrap(): void {
  const scrap = el('[data-zone="backlog"] [data-id="b1"]');
  pointer(scrap, "pointerdown", 300, 750);
  pointer(window, "pointermove", 300, 740); // past the drag threshold
  expect(drag.current?.id).toBe("b1");
  pointer(window, "pointermove", OVER.x, OVER.y);
  vi.advanceTimersByTime(1500); // well past the edge dwell
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  store.sheet = {
    tasks: [
      {
        id: "b1",
        text: "call the bank",
        x: 0.2,
        y: 0.2,
        done: false,
        created: 1,
      },
      {
        id: "d1",
        text: "dentist",
        x: 0.5,
        y: 0.5,
        done: false,
        created: 2,
        day: today.value,
        order: 0,
      },
    ],
    archive: [],
  };
  vi.spyOn(store, "commit").mockImplementation(() => undefined);
  pane = mount(SchedulePane, { target: document.body });
  flushSync();
  // every element under the pointer resolves to the scheduled scrap
  const scheduled = el('.day-list [data-id="d1"]');
  document.elementFromPoint = () => scheduled;
});

afterEach(() => {
  pointer(window, "pointerup", OVER.x, OVER.y);
  void unmount(pane);
  delete (document as unknown as Record<string, unknown>)["elementFromPoint"];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("edge auto-scroll while dragging a scrap", () => {
  it("scrolls the stacked days when the day's own list cannot scroll", () => {
    // narrow layout: `.days` scrolls, a day's list is a plain short block
    // lying entirely inside `.days`' bottom edge band
    const days = el(".days");
    layout(days, { top: 50, bottom: 600 }, 1500);
    const list = el(".day-list");
    layout(list, { top: 565, bottom: 595 }, 30);

    holdOverScheduledScrap();

    expect(days.scrollTop).toBeGreaterThan(0);
  });

  it("scrolls a day's own list in the week grid, not the days", () => {
    // wide layout: each day's list is its own scroller
    const days = el(".days");
    layout(days, { top: 50, bottom: 600 }, 550);
    const list = el(".day-list");
    layout(list, { top: 90, bottom: 600 }, 1200);

    holdOverScheduledScrap();

    expect(list.scrollTop).toBeGreaterThan(0);
    expect(days.scrollTop).toBe(0);
  });
});
