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

function quick(label: string): HTMLButtonElement {
  const b = [
    ...document.querySelectorAll<HTMLButtonElement>("aside button"),
  ].find((el) => el.textContent === label);
  if (b === undefined) throw new Error(`no "${label}" button`);
  return b;
}

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
