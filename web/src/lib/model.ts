import * as v from "valibot";

// Schemas are loose: unknown fields (from a newer client) survive a
// round-trip through an older tab instead of being silently stripped.

/** A label tasks can be filed under; managed in the settings panel. */
export const ProjectSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
});
export type Project = v.InferOutput<typeof ProjectSchema>;

/** One scrap on the sheet. Positions are normalized to the pane (0..1). */
export const TaskSchema = v.looseObject({
  id: v.string(),
  text: v.string(),
  /** 0 = not urgent … 1 = urgent */
  x: v.number(),
  /** 0 = important … 1 = not important */
  y: v.number(),
  done: v.boolean(),
  created: v.number(),
  doneAt: v.optional(v.number()),
  /** scheduled local date, YYYY-MM-DD; absent = backlog */
  day: v.optional(v.pipe(v.string(), v.isoDate())),
  /** position within its day; meaningless without `day` */
  order: v.optional(v.number()),
  /** id of the task's project; absent = none */
  project: v.optional(v.string()),
  /** free-text annotations; absent = none */
  note: v.optional(v.string()),
});
export type Task = v.InferOutput<typeof TaskSchema>;

/**
 * The renderer keys its lists by these fields ({#each … (key)}) and Svelte
 * throws on duplicate keys, so a sheet that repeats one must not be adopted.
 */
const uniqueBy = <T>(key: (item: T) => unknown) =>
  v.check<T[], string>(
    (items) => new Set(items.map(key)).size === items.length,
    "duplicate key",
  );
const UniqueTasksSchema = v.pipe(
  v.array(TaskSchema),
  uniqueBy((t: Task) => t.id),
);

export const ArchivedSheetSchema = v.looseObject({
  at: v.number(),
  tasks: UniqueTasksSchema,
});
export type ArchivedSheet = v.InferOutput<typeof ArchivedSheetSchema>;

/** The whole persisted document — exactly what lives in tasks.json. */
export const SheetSchema = v.looseObject({
  tasks: UniqueTasksSchema,
  archive: v.pipe(
    v.array(ArchivedSheetSchema),
    uniqueBy((a: ArchivedSheet) => a.at),
  ),
  /** absent on sheets written before projects existed */
  projects: v.optional(
    v.pipe(
      v.array(ProjectSchema),
      uniqueBy((p: Project) => p.id),
    ),
  ),
  /** ms timestamp of the last local change; newer side wins on sync */
  savedAt: v.optional(v.number()),
});
export type Sheet = v.InferOutput<typeof SheetSchema>;

export const emptySheet = (): Sheet => ({ tasks: [], archive: [] });

/** Strict boundary parse: a malformed sheet is rejected whole, never half-adopted. */
export function parseSheet(text: string): Sheet | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = v.safeParse(SheetSchema, raw);
  return result.success ? result.output : null;
}

/** Last writer wins: take the remote sheet unless ours is strictly newer. */
export function reconcile(local: Sheet, remote: Sheet): "adopt" | "push" {
  return (remote.savedAt ?? 0) >= (local.savedAt ?? 0) ? "adopt" : "push";
}

/**
 * The paper-rewrite ritual: crossed-out tasks move to a dated archive entry,
 * open tasks carry over. Returns null when nothing is crossed out.
 */
export function freshSheet(sheet: Sheet, now: number): Sheet | null {
  const done = sheet.tasks.filter((t) => t.done);
  if (done.length === 0) return null;
  return {
    ...sheet,
    tasks: sheet.tasks.filter((t) => !t.done),
    archive: [...sheet.archive, { at: now, tasks: done }],
  };
}

/** Keep notes inside the pane so they can always be grabbed again. */
export function clampPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(0.98, Math.max(0.02, x)),
    y: Math.min(0.97, Math.max(0.03, y)),
  };
}

/**
 * Collision-resistant id that also works in insecure contexts
 * (crypto.randomUUID is unavailable over plain http on the LAN).
 */
export function newId(): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return (
    Date.now().toString(36) + Array.from(rand, (n) => n.toString(36)).join("")
  );
}

/** Stable pseudo-random tilt per task, like a scrap laid on a desk. */
export function rotation(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (((h % 100) / 100) * 3.6 - 1.8).toFixed(2) + "deg";
}
