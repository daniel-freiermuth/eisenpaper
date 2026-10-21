import { describe, expect, it } from "vitest";

import {
  clampPosition,
  freshSheet,
  mergeSheets,
  nextProjectColor,
  parseSheet,
  PROJECT_COLORS,
  rotation,
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

  // JSON.parse turns an overflowing literal into ±Infinity, which
  // JSON.stringify would write back as null — a sheet no client can load.
  it.each([
    [
      "x",
      `{"tasks":[{"id":"t","text":"x","x":1e999,"y":0,"done":false,"created":1}],"archive":[]}`,
    ],
    [
      "y",
      `{"tasks":[{"id":"t","text":"x","x":0,"y":-1e999,"done":false,"created":1}],"archive":[]}`,
    ],
    [
      "created",
      `{"tasks":[{"id":"t","text":"x","x":0,"y":0,"done":false,"created":1e999}],"archive":[]}`,
    ],
    [
      "doneAt",
      `{"tasks":[{"id":"t","text":"x","x":0,"y":0,"done":true,"created":1,"doneAt":1e999}],"archive":[]}`,
    ],
    [
      "order",
      `{"tasks":[{"id":"t","text":"x","x":0,"y":0,"done":false,"created":1,"order":-1e999}],"archive":[]}`,
    ],
    ["archive at", `{"tasks":[],"archive":[{"at":1e999,"tasks":[]}]}`],
  ])("rejects a non-finite %s", (_field, text) => {
    expect(parseSheet(text)).toBeNull();
  });
});

describe("mergeSheets", () => {
  const sheet = (tasks: Task[], archive: Sheet["archive"] = []): Sheet => ({
    tasks,
    archive,
  });
  const a = task({ id: "a", text: "file tax return" });
  const b = task({ id: "b", text: "call the plumber" });
  const base = sheet([a, b]);

  it("keeps tasks added on either side, remote order first", () => {
    const mine = task({ id: "mine" });
    const theirs = task({ id: "theirs" });
    const merged = mergeSheets(
      base,
      sheet([mine, a, b]),
      sheet([a, theirs, b]),
    );
    expect(merged.tasks.map((t) => t.id)).toEqual(["a", "theirs", "b", "mine"]);
  });

  it("keeps edits to different fields of one task from both sides", () => {
    const merged = mergeSheets(
      base,
      sheet([{ ...a, done: true, doneAt: 7 }, b]),
      sheet([{ ...a, x: 0.1, y: 0.9 }, b]),
    );
    expect(merged.tasks[0]).toEqual({
      ...a,
      done: true,
      doneAt: 7,
      x: 0.1,
      y: 0.9,
    });
  });

  it("lets the local value win only when both sides changed the same field", () => {
    const merged = mergeSheets(
      base,
      sheet([{ ...a, text: "mine" }, b]),
      sheet([
        { ...a, text: "theirs" },
        { ...b, text: "theirs too" },
      ]),
    );
    expect(merged.tasks.map((t) => t.text)).toEqual(["mine", "theirs too"]);
  });

  it("drops a field one side removed and the other left alone", () => {
    const scheduled = task({ id: "a", day: "2026-10-20", order: 0 });
    const backlogged = task({ id: "a" });
    const merged = mergeSheets(
      sheet([scheduled]),
      sheet([scheduled]),
      sheet([backlogged]),
    );
    expect(merged.tasks).toEqual([backlogged]);
  });

  it("deletes a task removed on either side, unless the other side changed it", () => {
    expect(mergeSheets(base, sheet([b]), sheet([a, b])).tasks).toEqual([b]);
    expect(mergeSheets(base, sheet([a, b]), sheet([b])).tasks).toEqual([b]);
    const edited = { ...a, text: "still needed" };
    expect(mergeSheets(base, sheet([edited, b]), sheet([b])).tasks).toEqual([
      b,
      edited,
    ]);
  });

  it("merges fresh sheets run on both sides without losing either archive", () => {
    const doneA = { ...a, done: true };
    const doneB = { ...b, done: true };
    const merged = mergeSheets(
      sheet([doneA, doneB]),
      sheet([doneB], [{ at: 1, tasks: [doneA] }]),
      sheet([doneA], [{ at: 2, tasks: [doneB] }]),
    );
    expect(merged.tasks).toEqual([]);
    expect(merged.archive.map((e) => e.at)).toEqual([2, 1]);
  });

  it("without a base, keeps everything from both sides", () => {
    const mine = { ...a, text: "mine" };
    const merged = mergeSheets(sheet([]), sheet([mine]), sheet([a, b]));
    expect(merged.tasks).toEqual([mine, b]);
  });

  it("returns the remote sheet unchanged when nothing changed locally", () => {
    const remote = sheet([{ ...a, text: "theirs" }, task({ id: "c" })]);
    expect(mergeSheets(base, base, remote)).toEqual(remote);
  });

  it("merges projects by id, keeping additions and edits from both sides", () => {
    const garden = { id: "g", name: "garden", color: "#2f5d9e" };
    const work = { id: "w", name: "work" };
    const old = { id: "o", name: "old" };
    const merged = mergeSheets(
      { ...base, projects: [garden, work, old] },
      {
        ...base,
        projects: [
          { ...garden, name: "yard" },
          work,
          { id: "m", name: "mine" },
        ],
      },
      {
        ...base,
        projects: [
          { ...garden, color: "#2a7f7a" },
          work,
          old,
          { id: "t", name: "theirs" },
        ],
      },
    );
    expect(merged.projects).toEqual([
      { id: "g", name: "yard", color: "#2a7f7a" },
      work,
      { id: "t", name: "theirs" },
      { id: "m", name: "mine" },
    ]);
  });

  it("folds a project added under a name the other side already uses, ignoring case", () => {
    const mine = { ...a, project: "m" };
    const archived = { ...b, done: true, project: "m" };
    const merged = mergeSheets(
      sheet([]),
      {
        ...sheet([mine], [{ at: 1, tasks: [archived] }]),
        projects: [{ id: "m", name: "Garden", color: "#2f5d9e" }],
      },
      { ...sheet([]), projects: [{ id: "g", name: "garden" }] },
    );
    expect(merged.projects).toEqual([{ id: "g", name: "garden" }]);
    expect(merged.tasks).toEqual([{ ...a, project: "g" }]);
    expect(merged.archive).toEqual([
      { at: 1, tasks: [{ ...archived, project: "g" }] },
    ]);
  });

  it("merges fields it does not know, so newer clients' data survives", () => {
    const merged = mergeSheets(
      { ...base, theme: "dark" },
      { ...base, theme: "dark", pinned: ["a"] },
      { ...base, theme: "light" },
    );
    expect(merged).toMatchObject({ theme: "light", pinned: ["a"] });
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

describe("rotation", () => {
  it("stays within ±1.8deg even when the id hash is negative", () => {
    for (const id of ["aaaaaaaa", "zzzzzzzz", "note-1"]) {
      expect(Math.abs(parseFloat(rotation(id)))).toBeLessThanOrEqual(1.8);
    }
  });
});
