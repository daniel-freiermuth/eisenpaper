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

import DetailPane from "./DetailPane.svelte";
import { addDays } from "./schedule";
import { store } from "./sheet.svelte";
import { today } from "./today.svelte";
import { buttonLabelled } from "./test-dom";

let pane: Record<string, unknown>;
let commit: MockInstance<() => void>;

const onDay = (id: string, order: number) => ({
  id,
  text: id,
  x: 0.5,
  y: 0.5,
  done: false,
  created: 1,
  day: today.value,
  order,
});

const quick = (label: string): HTMLButtonElement =>
  buttonLabelled(label, "aside button");

beforeEach(() => {
  store.select(null);
  store.sheet = {
    tasks: [onDay("a", 0), onDay("b", 1), onDay("c", 2)],
    archive: [],
  };
  commit = vi.spyOn(store, "commit").mockImplementation(() => undefined);
  pane = mount(DetailPane, {
    target: document.body,
    props: { onManageProjects: () => undefined },
  });
  store.select("a");
  flushSync();
});

afterEach(() => {
  void unmount(pane);
  vi.restoreAllMocks();
});

describe("DetailPane quick days", () => {
  it("leaves the day's order alone when the task's own (active) day is clicked", () => {
    const btn = quick("today");
    expect(btn.classList.contains("active")).toBe(true);

    btn.click();
    flushSync();

    expect(store.sheet.tasks.map((t) => t.order)).toEqual([0, 1, 2]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("still schedules the task when another day is clicked", () => {
    quick("tomorrow").click();
    flushSync();

    const a = store.sheet.tasks.find((t) => t.id === "a");
    expect(a?.day).toBe(addDays(today.value, 1));
    expect(a?.order).toBe(0);
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe("DetailPane day field", () => {
  it("shows the kept day again when the typed day is refused", () => {
    const input = document.querySelector<HTMLInputElement>("#detail-day");
    if (input === null) throw new Error("no day field");
    // a browser keeps a typed five-digit year (the spec allows years past
    // 9999); happy-dom's sanitizer would turn it into "" instead
    let raw = "20266-10-25";
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => raw,
      set: (v: string) => {
        raw = v;
      },
    });

    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();

    expect(store.sheet.tasks.find((t) => t.id === "a")?.day).toBe(today.value);
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe(today.value);
  });

  it("leaves the field alone when a cleared part of the day empties it", () => {
    const input = document.querySelector<HTMLInputElement>("#detail-day");
    if (input === null) throw new Error("no day field");
    // Chromium reports "" once one part (month, day, year) is cleared, and
    // writing "" back wipes the parts the user is still about to complete;
    // happy-dom has no parts, so record the writes instead
    const writes: string[] = [];
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: (v: string) => {
        writes.push(v);
      },
    });

    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();

    expect(store.sheet.tasks.find((t) => t.id === "a")?.day).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
