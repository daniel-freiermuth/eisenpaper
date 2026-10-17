import type { Task } from "./model";

// Days are local calendar dates as YYYY-MM-DD strings: they compare
// lexicographically, survive JSON untouched and never drift with timezones
// or DST the way timestamps do.

/** The local calendar date of `date`. */
export function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${m}-${d}`;
}

/** Local midnight of a day key. */
export function dayDate(day: string): Date {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Calendar arithmetic: `n` days after `day` (negative goes back). */
export function addDays(day: string, n: number): string {
  const date = dayDate(day);
  date.setDate(date.getDate() + n);
  return dayKey(date);
}

/** Distance to the top-right (urgent + important) corner; lower comes first. */
const urgencyRank = (t: Task): number => Math.hypot(1 - t.x, t.y);

/** Unscheduled tasks, most urgent-and-important first. */
export function backlog(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((t) => t.day === undefined)
    .sort((a, b) => urgencyRank(a) - urgencyRank(b) || a.created - b.created);
}

const byDayOrder = (a: Task, b: Task): number =>
  (a.order ?? Infinity) - (b.order ?? Infinity) || a.created - b.created;

/** Open tasks scheduled before `today`, oldest day first. */
export function overdue(tasks: readonly Task[], today: string): Task[] {
  return tasks
    .filter((t) => !t.done && t.day !== undefined && t.day < today)
    .sort((a, b) =>
      a.day === b.day
        ? byDayOrder(a, b)
        : (a.day ?? "") < (b.day ?? "")
          ? -1
          : 1,
    );
}

/** Everything scheduled on `day`, crossed-out included, in the user's order. */
export function tasksOn(tasks: readonly Task[], day: string): Task[] {
  return tasks.filter((t) => t.day === day).sort(byDayOrder);
}

/**
 * Moves a task to `index` within `day` (renumbering that day), or back to
 * the backlog when `day` is null. Mutates in place so reactive proxies see it.
 */
export function placeTask(
  tasks: readonly Task[],
  id: string,
  day: string | null,
  index: number,
): void {
  const task = tasks.find((t) => t.id === id);
  if (task === undefined) return;
  if (day === null) {
    delete task.day;
    delete task.order;
    return;
  }
  const siblings = tasksOn(tasks, day).filter((t) => t.id !== id);
  siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, task);
  task.day = day;
  siblings.forEach((t, i) => {
    t.order = i;
  });
}

const fmt = (day: string, opts: Intl.DateTimeFormatOptions): string =>
  dayDate(day).toLocaleDateString("en-GB", opts);

/** Short relative label for a scheduled day: "today", "Fri", "14 Oct". */
export function dueLabel(day: string, today: string): string {
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  if (day > today && day < addDays(today, 7))
    return fmt(day, { weekday: "short" });
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return fmt(day, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Column heading for a day: a name plus its date. */
export function dayHeading(
  day: string,
  today: string,
): { name: string; date: string; weekend: boolean } {
  const weekday = dayDate(day).getDay();
  const name =
    day === today
      ? "today"
      : day === addDays(today, 1)
        ? "tomorrow"
        : fmt(day, { weekday: "long" });
  return {
    name,
    date: fmt(day, { day: "numeric", month: "short" }),
    weekend: weekday === 0 || weekday === 6,
  };
}
