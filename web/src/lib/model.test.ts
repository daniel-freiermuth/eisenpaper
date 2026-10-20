import { describe, expect, it } from "vitest";

import {
  clampPosition,
  freshSheet,
  nextProjectColor,
  parseSheet,
  PROJECT_COLORS,
  reconcile,
  splitAlpha,
  tintColor,
  withAlpha,
  type Sheet,
  type Task,
} from "./model";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  text: "file tax return",
  x: 0.7,
  y: 0.25,
  done: false,
  created: 1,
  ...over,
});

describe("parseSheet", () => {
  it("accepts a sheet written by the vanilla v1 app", () => {
    const text = JSON.stringify({
      tasks: [task(), task({ id: "t2", done: true, doneAt: 5 })],
      archive: [{ at: 9, tasks: [task({ id: "t3", done: true })] }],
      savedAt: 10,
    });
    expect(parseSheet(text)?.tasks).toHaveLength(2);
  });

  it("keeps fields it does not know, so newer clients' data survives", () => {
    const text = JSON.stringify({
      tasks: [{ ...task(), tags: ["home"] }],
      archive: [],
    });
    expect(parseSheet(text)?.tasks[0]).toHaveProperty("tags", ["home"]);
  });

  it.each([
    ["broken JSON", "{not json"],
    ["missing archive", JSON.stringify({ tasks: [] })],
    [
      "one malformed task rejects the whole sheet",
      JSON.stringify({
        tasks: [task(), { ...task({ id: "t2" }), done: "yes" }],
        archive: [],
      }),
    ],
    [
      "task without position",
      JSON.stringify({
        tasks: [{ id: "t", text: "x", done: false, created: 1 }],
        archive: [],
      }),
    ],
    [
      "two tasks sharing an id",
      JSON.stringify({ tasks: [task(), task()], archive: [] }),
    ],
    [
      "two archived tasks sharing an id in one entry",
      JSON.stringify({
        tasks: [],
        archive: [{ at: 9, tasks: [task(), task()] }],
      }),
    ],
    [
      "two archive entries sharing a timestamp",
      JSON.stringify({
        tasks: [],
        archive: [
          { at: 9, tasks: [task()] },
          { at: 9, tasks: [task({ id: "t2" })] },
        ],
      }),
    ],
    [
      "two projects sharing an id",
      JSON.stringify({
        tasks: [],
        archive: [],
        projects: [
          { id: "p", name: "garden" },
          { id: "p", name: "work" },
        ],
      }),
    ],
  ])("rejects %s", (_name, text) => {
    expect(parseSheet(text)).toBeNull();
  });
});

describe("reconcile", () => {
  const sheet = (savedAt?: number): Sheet =>
    savedAt === undefined
      ? { tasks: [], archive: [] }
      : { tasks: [], archive: [], savedAt };

  it("adopts a newer remote", () => {
    expect(reconcile(sheet(1), sheet(2))).toBe("adopt");
  });
  it("pushes when local is strictly newer", () => {
    expect(reconcile(sheet(2), sheet(1))).toBe("push");
  });
  it("adopts on a tie, so the file on disk stays authoritative", () => {
    expect(reconcile(sheet(3), sheet(3))).toBe("adopt");
  });
  it("treats a missing timestamp as oldest", () => {
    expect(reconcile(sheet(1), sheet())).toBe("push");
    expect(reconcile(sheet(), sheet(1))).toBe("adopt");
  });
});

describe("freshSheet", () => {
  it("archives crossed-out tasks and carries open ones over", () => {
    const open = task({ id: "open" });
    const done = task({ id: "done", done: true });
    const next = freshSheet({ tasks: [open, done], archive: [] }, 42);
    expect(next?.tasks).toEqual([open]);
    expect(next?.archive).toEqual([{ at: 42, tasks: [done] }]);
  });

  it("appends to existing archive history", () => {
    const old = { at: 1, tasks: [task({ id: "old", done: true })] };
    const next = freshSheet(
      { tasks: [task({ done: true })], archive: [old] },
      2,
    );
    expect(next?.archive.map((a) => a.at)).toEqual([1, 2]);
  });

  it("returns null when nothing is crossed out", () => {
    expect(freshSheet({ tasks: [task()], archive: [] }, 1)).toBeNull();
  });
});

describe("clampPosition", () => {
  it("keeps notes grabbable at every edge", () => {
    expect(clampPosition(-1, 2)).toEqual({ x: 0.02, y: 0.97 });
    expect(clampPosition(5, -3)).toEqual({ x: 0.98, y: 0.03 });
  });
  it("leaves interior positions untouched", () => {
    expect(clampPosition(0.4, 0.6)).toEqual({ x: 0.4, y: 0.6 });
  });
});

describe("nextProjectColor", () => {
  const projects = (colors: (string | undefined)[]) =>
    colors.map((color, i) =>
      color === undefined
        ? { id: String(i), name: String(i) }
        : { id: String(i), name: String(i), color },
    );

  it("takes the first colour nobody uses, filling gaps left by deletions", () => {
    const [first, second, third] = PROJECT_COLORS;
    expect(nextProjectColor(projects([]))).toBe(first);
    expect(nextProjectColor(projects([first, third, undefined]))).toBe(second);
  });

  it("cycles through the palette once every colour is taken", () => {
    const all = projects([...PROJECT_COLORS]);
    expect(nextProjectColor(all)).toBe(PROJECT_COLORS[0]);
    expect(nextProjectColor([...all, ...projects([undefined])])).toBe(
      PROJECT_COLORS[1],
    );
  });
});

describe("project colour alpha", () => {
  it("tints opaque colours at the default strength, keeps picked alpha", () => {
    expect(tintColor("#2F5D9E")).toBe("#2f5d9e47"); // 28%
    expect(tintColor("#ff990080")).toBe("#ff990080");
    expect(tintColor("#ff9900ff")).toBe("#ff9900ff"); // fully opaque on purpose
  });

  it("round-trips a picked colour through hue and opacity", () => {
    const parts = splitAlpha(withAlpha("#FF9900", 0.5));
    expect(parts?.rgb).toBe("#ff9900");
    expect(parts?.alpha).toBeCloseTo(0.5, 2);
    expect(splitAlpha("#ff9900")).toEqual({ rgb: "#ff9900", alpha: 1 });
  });

  it("clamps opacity and rejects colours it cannot split", () => {
    expect(withAlpha("#000000", 1.7)).toBe("#000000ff");
    expect(withAlpha("#000000", -1)).toBe("#00000000");
    expect(splitAlpha("red")).toBeNull();
    expect(splitAlpha("#abc")).toBeNull();
  });
});
