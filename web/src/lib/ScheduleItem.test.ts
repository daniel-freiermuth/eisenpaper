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

import { addDays } from "./schedule";
import SchedulePane from "./SchedulePane.svelte";
import { store } from "./sheet.svelte";
import { today } from "./today.svelte";

// SchedulePane is the real host: it lists the overdue scrap with the ×
// button, so the press travels through the scrap's drag and key handling
// just as it does in the app.
let pane: Record<string, unknown>;
let commit: MockInstance<() => void>;

const PAST = addDays(today.value, -3);

function task() {
  const t = store.sheet.tasks[0];
  if (t === undefined) throw new Error("no task on the sheet");
  return t;
}

function unscheduleButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    'button[aria-label="unschedule"]',
  );
  if (el === null) throw new Error("no unschedule button");
  return el;
}

const pointer = (type: string): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    button: 0,
    pointerType: "mouse",
    clientX: 10,
    clientY: 10,
  });

beforeEach(() => {
  store.cancelEdit();
  store.sheet = {
    tasks: [
      { id: "t1", text: "late", x: 0.5, y: 0.5, done: false, created: 1 },
    ],
    archive: [],
  };
  store.schedule("t1", PAST, 0);
  // persistence is SheetStore's concern (sheet.svelte.test.ts)
  commit = vi.spyOn(store, "commit").mockImplementation(() => undefined);
  pane = mount(SchedulePane, { target: document.body });
  flushSync();
});

afterEach(() => {
  void unmount(pane);
  vi.restoreAllMocks();
});

describe("ScheduleItem unschedule button", () => {
  it("sends an overdue scrap back to the backlog when clicked", () => {
    const btn = unscheduleButton();

    btn.dispatchEvent(pointer("pointerdown"));
    btn.dispatchEvent(pointer("pointerup"));
    flushSync();
    btn.click();
    flushSync();

    expect(task().done).toBe(false);
    expect(task().day).toBeUndefined();
    expect(commit).toHaveBeenCalledOnce();
  });

  it.each(["Enter", " "])(
    "sends an overdue scrap back to the backlog on %j",
    (key) => {
      const btn = unscheduleButton();
      btn.focus();

      const down = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      btn.dispatchEvent(down);
      flushSync();
      // the browser activates a focused button unless keydown was cancelled
      if (!down.defaultPrevented && btn.isConnected) btn.click();
      flushSync();

      expect(task().done).toBe(false);
      expect(task().day).toBeUndefined();
    },
  );
});
