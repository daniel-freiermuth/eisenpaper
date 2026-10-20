import * as v from "valibot";

// Schemas are loose: unknown fields (from a newer client) survive a
// round-trip through an older tab instead of being silently stripped.

/** A label tasks can be filed under; managed in the settings panel. */
export const ProjectSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  /** a PROJECT_COLORS entry, or a picked #rrggbbaa; absent = no tint */
  color: v.optional(v.string()),
});
export type Project = v.InferOutput<typeof ProjectSchema>;

/** Ink colours that stay readable on the paper background. */
export const PROJECT_COLORS = [
  "#2f5d9e", // blue
  "#2a7f7a", // teal
  "#4f7a2a", // green
  "#9a7b16", // ochre
  "#b5562b", // rust
  "#a23b72", // plum
  "#7a4a9e", // violet
  "#5a6470", // slate
] as const;

/** The first palette colour no project uses yet; cycles once all are taken. */
export function nextProjectColor(projects: readonly Project[]): string {
  const used = new Set(projects.map((p) => p.color));
  return (
    PROJECT_COLORS.find((c) => !used.has(c)) ??
    PROJECT_COLORS[projects.length % PROJECT_COLORS.length] ??
    PROJECT_COLORS[0]
  );
}

/** How strongly an opaque (#rrggbb) project colour tints a task. */
export const DEFAULT_TINT_ALPHA = 0.28;

/**
 * The colour a task's background is tinted with. Opaque #rrggbb colours
 * (the palette) get the default strength; a picked #rrggbbaa keeps its own.
 */
export function tintColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color)
    ? withAlpha(color, DEFAULT_TINT_ALPHA)
    : color;
}

/** #rrggbb or #rrggbbaa → opaque #rrggbb plus alpha (0..1); null otherwise. */
export function splitAlpha(
  color: string,
): { rgb: string; alpha: number } | null {
  const m = /^(#[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (m?.[1] === undefined) return null;
  return {
    rgb: m[1].toLowerCase(),
    alpha: m[2] === undefined ? 1 : parseInt(m[2], 16) / 255,
  };
}

/** #rrggbb plus alpha (clamped to 0..1) → #rrggbbaa. */
export function withAlpha(rgb: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return rgb.toLowerCase() + a.toString(16).padStart(2, "0");
}

/**
 * JSON.parse reads an overflowing literal (1e999) as ±Infinity, which
 * JSON.stringify would write back as null; only finite numbers round-trip.
 */
const FiniteSchema = v.pipe(v.number(), v.finite());

/** One scrap on the sheet. Positions are normalized to the pane (0..1). */
export const TaskSchema = v.looseObject({
  id: v.string(),
  text: v.string(),
  /** 0 = not urgent … 1 = urgent */
  x: FiniteSchema,
  /** 0 = important … 1 = not important */
  y: FiniteSchema,
  done: v.boolean(),
  created: FiniteSchema,
  doneAt: v.optional(FiniteSchema),
  /** scheduled local date, YYYY-MM-DD; absent = backlog */
  day: v.optional(
    v.pipe(
      v.string(),
      v.isoDate(),
      // isoDate checks only the format; "2026-11-31" must not pass.
      v.check((s) => {
        const [y, m, d] = s.split("-").map(Number) as [number, number, number];
        const date = new Date(y, m - 1, d);
        return date.getMonth() === m - 1 && date.getDate() === d;
      }, "Invalid calendar date"),
    ),
  ),
  /** position within its day; meaningless without `day` */
  order: v.optional(FiniteSchema),
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
  at: FiniteSchema,
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

/** Structural equality of JSON values: key order and undefined fields don't count. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    );
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  return [...keys].every((k) => sameJson(ra[k], rb[k]));
}

/**
 * Field-by-field three-way merge: a field takes the side that changed it
 * since `base`; when both did, the local value wins. A field one side
 * removed (and the other left alone) is removed. Remote key order is kept.
 */
function mergeFields<T extends Record<string, unknown>>(
  base: T | undefined,
  local: T,
  remote: T,
): T {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const value = sameJson(local[key], base?.[key]) ? remote[key] : local[key];
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Three-way merge of two lists of keyed items. An item on both sides is
 * merged with `mergeItem`; one that only one side has is kept if that side
 * added or changed it, and dropped if it is the base version the other
 * side removed. Remote order first, then local additions.
 */
function mergeByKey<T>(
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  key: (item: T) => unknown,
  mergeItem: (base: T | undefined, local: T, remote: T) => T,
): T[] {
  const baseBy = new Map(base.map((item) => [key(item), item]));
  const localBy = new Map(local.map((item) => [key(item), item]));
  const remoteKeys = new Set(remote.map(key));
  const keptBy = (item: T): boolean => {
    const was = baseBy.get(key(item));
    return was === undefined || !sameJson(item, was);
  };
  const out: T[] = [];
  for (const r of remote) {
    const l = localBy.get(key(r));
    if (l !== undefined) out.push(mergeItem(baseBy.get(key(r)), l, r));
    else if (keptBy(r)) out.push(r);
  }
  for (const l of local) {
    if (!remoteKeys.has(key(l)) && keptBy(l)) out.push(l);
  }
  return out;
}

/**
 * Merges the local sheet with the server's, both descended from `base`
 * (the server sheet this device last saw; empty if it never saw one).
 * Tasks and projects merge by `id` and field by field, archive entries by
 * `at`, so edits to different items or fields on two devices all survive.
 * Only when both changed the same field does the local value win; an item
 * one side deleted stays deleted unless the other side changed it.
 */
export function mergeSheets(base: Sheet, local: Sheet, remote: Sheet): Sheet {
  const merged: Sheet = {
    ...mergeFields(base, local, remote),
    tasks: mergeByKey(
      base.tasks,
      local.tasks,
      remote.tasks,
      (t) => t.id,
      mergeFields,
    ),
    archive: mergeByKey(
      base.archive,
      local.archive,
      remote.archive,
      (a) => a.at,
      mergeFields,
    ),
  };
  if (local.projects !== undefined || remote.projects !== undefined) {
    merged.projects = mergeByKey(
      base.projects ?? [],
      local.projects ?? [],
      remote.projects ?? [],
      (p) => p.id,
      mergeFields,
    );
  }
  return merged;
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
  return (((((h % 100) + 100) % 100) / 100) * 3.6 - 1.8).toFixed(2) + "deg";
}
