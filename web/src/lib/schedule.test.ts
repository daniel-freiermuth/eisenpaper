import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseSheet, type Task } from "./model";
import {
  addDays,
  backlog,
  dayHeading,
  dueLabel,
  overdue,
  placeTask,
  tasksOn,
} from "./schedule";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: id,
  x: 0.5,
  y: 0.5,
  done: false,
  created: 1,
  ...over,
});

const ids = (tasks: Task[]): string[] => tasks.map((t) => t.id);

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });
  it("is not thrown off by a DST switch", () => {
    // Europe's clocks change on 2026-10-25 and 2027-03-28
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2027-03-27", 2)).toBe("2027-03-29");
  });
});

describe("backlog", () => {
  it("ranks by closeness to the urgent + important corner", () => {
    const tasks = [
      task("calm", { x: 0.1, y: 0.9 }),
      task("fire", { x: 0.95, y: 0.05 }),
      task("soon", { x: 0.7, y: 0.4 }),
    ];
    expect(ids(backlog(tasks))).toEqual(["fire", "soon", "calm"]);
  });
  it("leaves out scheduled tasks", () => {
    const tasks = [task("a"), task("b", { day: "2026-10-20" })];
    expect(ids(backlog(tasks))).toEqual(["a"]);
  });
});

describe("overdue", () => {
  const today = "2026-10-17";
  it("holds open tasks from past days only, oldest first", () => {
    const tasks = [
      task("yesterday", { day: "2026-10-16" }),
      task("lastweek", { day: "2026-10-10" }),
      task("done", { day: "2026-10-15", done: true }),
      task("today", { day: today }),
      task("unscheduled"),
    ];
    expect(ids(overdue(tasks, today))).toEqual(["lastweek", "yesterday"]);
  });
  it("orders tasks sharing a past day by order, then created", () => {
    const day = "2026-10-16";
    const tasks = [
      task("loose-late", { day, created: 5 }),
      task("second", { day, order: 1 }),
      task("loose-early", { day, created: 2 }),
      task("first", { day, order: 0 }),
    ];
    expect(ids(overdue(tasks, today))).toEqual([
      "first",
      "second",
      "loose-early",
      "loose-late",
    ]);
  });
});

describe("tasksOn", () => {
  it("puts tasks without an order last, falling back to created", () => {
    const day = "2026-10-20";
    const tasks = [
      task("loose-late", { day, created: 9 }),
      task("loose-early", { day, created: 3 }),
      task("ordered", { day, order: 4 }),
    ];
    expect(ids(tasksOn(tasks, day))).toEqual([
      "ordered",
      "loose-early",
      "loose-late",
    ]);
  });
});

describe("placeTask", () => {
  const day = "2026-10-20";

  it("inserts at the drop position and renumbers the day", () => {
    const tasks = [
      task("a", { day, order: 0 }),
      task("b", { day, order: 1 }),
      task("new"),
    ];
    placeTask(tasks, "new", day, 1);
    expect(ids(tasksOn(tasks, day))).toEqual(["a", "new", "b"]);
    expect(tasks.map((t) => t.order)).toEqual([0, 2, 1]);
  });

  it("reorders within a day", () => {
    const tasks = [
      task("a", { day, order: 0 }),
      task("b", { day, order: 1 }),
      task("c", { day, order: 2 }),
    ];
    placeTask(tasks, "a", day, 2);
    expect(ids(tasksOn(tasks, day))).toEqual(["b", "c", "a"]);
  });

  it("moves between days, leaving the old day's order intact", () => {
    const other = "2026-10-21";
    const tasks = [
      task("a", { day, order: 0 }),
      task("b", { day, order: 1 }),
      task("c", { day: other, order: 0 }),
    ];
    placeTask(tasks, "a", other, 0);
    expect(ids(tasksOn(tasks, day))).toEqual(["b"]);
    expect(ids(tasksOn(tasks, other))).toEqual(["a", "c"]);
  });

  it("clamps an index past the end", () => {
    const tasks = [task("a", { day, order: 0 }), task("b")];
    placeTask(tasks, "b", day, 99);
    expect(ids(tasksOn(tasks, day))).toEqual(["a", "b"]);
  });

  it("clamps a negative index to the top", () => {
    const tasks = [task("a", { day, order: 0 }), task("b")];
    placeTask(tasks, "b", day, -3);
    expect(ids(tasksOn(tasks, day))).toEqual(["b", "a"]);
  });

  it("ignores an unknown id", () => {
    const tasks = [task("a", { day, order: 0 }), task("b")];
    const before = structuredClone(tasks);
    placeTask(tasks, "gone", day, 0);
    expect(tasks).toEqual(before);
  });

  it("renumbers crossed-out siblings and leaves other days alone", () => {
    const other = "2026-10-21";
    const tasks = [
      task("open", { day, order: 3 }),
      task("crossed", { day, order: 7, done: true }),
      task("elsewhere", { day: other, order: 5 }),
      task("new"),
    ];
    placeTask(tasks, "new", day, 1);
    expect(ids(tasksOn(tasks, day))).toEqual(["open", "new", "crossed"]);
    expect(tasks.map((t) => t.order)).toEqual([0, 2, 5, 1]);
  });

  it("unschedules back to the backlog", () => {
    const tasks = [task("a", { day: "2026-10-01", order: 3 })];
    placeTask(tasks, "a", null, 0);
    expect(tasks[0]).not.toHaveProperty("day");
    expect(tasks[0]).not.toHaveProperty("order");
    expect(ids(backlog(tasks))).toEqual(["a"]);
  });
});

describe("dueLabel", () => {
  const today = "2026-10-17"; // a Saturday
  it.each([
    ["2026-10-17", "today"],
    ["2026-10-18", "tomorrow"],
    ["2026-10-22", "Thu"],
    ["2026-10-24", "Sat 24 Oct"],
    ["2026-10-14", "Wed 14 Oct"],
    ["2027-01-05", "Tue, 5 Jan 2027"],
  ])("%s → %s", (day, label) => {
    expect(dueLabel(day, today)).toBe(label);
  });
});

describe("dayHeading", () => {
  // A negative UTC offset, where parsing a day key as UTC midnight would
  // land on the previous local day and shift the weekday.
  const tz = process.env["TZ"];
  beforeAll(() => {
    process.env["TZ"] = "America/Los_Angeles";
  });
  afterAll(() => {
    if (tz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = tz;
  });

  const today = "2026-10-15"; // a Thursday
  it.each([
    ["2026-10-15", "today", "15 Oct", false],
    ["2026-10-16", "tomorrow", "16 Oct", false],
    ["2026-10-17", "Saturday", "17 Oct", true],
    ["2026-10-18", "Sunday", "18 Oct", true],
    ["2026-10-19", "Monday", "19 Oct", false],
    ["2026-10-14", "Wednesday", "14 Oct", false],
  ])("%s → %s %s", (day, name, date, weekend) => {
    expect(dayHeading(day, today)).toEqual({ name, date, weekend });
  });
});

describe("sheet schema", () => {
  it("round-trips a scheduled task", () => {
    const text = JSON.stringify({
      tasks: [task("a", { day: "2026-10-20", order: 0 })],
      archive: [],
    });
    expect(parseSheet(text)?.tasks[0]?.day).toBe("2026-10-20");
  });
  it("rejects a malformed day", () => {
    const text = JSON.stringify({
      tasks: [task("a", { day: "next tuesday" })],
      archive: [],
    });
    expect(parseSheet(text)).toBeNull();
  });
  it("rejects a day that does not exist in the calendar", () => {
    for (const day of ["2026-11-31", "2026-02-29", "2026-02-31"]) {
      const text = JSON.stringify({ tasks: [task("a", { day })], archive: [] });
      expect(parseSheet(text)).toBeNull();
    }
  });
  it("accepts a leap day", () => {
    const text = JSON.stringify({
      tasks: [task("a", { day: "2028-02-29" })],
      archive: [],
    });
    expect(parseSheet(text)?.tasks[0]?.day).toBe("2028-02-29");
  });
});
