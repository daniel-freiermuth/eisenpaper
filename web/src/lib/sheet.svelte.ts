import {
  clampPosition,
  emptySheet,
  freshSheet,
  mergeSheets,
  newId,
  nextProjectColor,
  parseSheet,
  sameJson,
  type Sheet,
  type Task,
} from "./model";
import { placeTask } from "./schedule";

export type SyncStatus = "loading" | "synced" | "saving" | "offline" | "error";

const CACHE_KEY = "eisenpaper.v1";
/**
 * The tasks.json text the cached sheet descends from: the base of the next
 * merge. Always written together with CACHE_KEY by the same tab, so the
 * pair stays consistent when several tabs share them.
 */
const BASE_KEY = "eisenpaper.v1.base";
/**
 * Set by the app before BASE_KEY existed while its cache had never synced.
 * That app also stamped the sheet's savedAt on every edit.
 */
const UNSYNCED_KEY = "eisenpaper.v1.unsynced";
const ENDPOINT = "tasks.json";
const WRITE_DELAY_MS = 300;
/** browsers cap the bodies of all keepalive requests in flight at 64 KiB
 * (of UTF-8, not UTF-16) together */
const KEEPALIVE_LIMIT = 60_000;
/** merges to retry when tasks.json keeps changing under a save */
const MAX_CONFLICT_RETRIES = 3;

/** Storage the browser blocks or has filled degrades to no cache at all. */
function cacheGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn("browser storage unavailable", e);
    return null;
  }
}

/** Returns false when the browser refused the write. */
function cacheSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn("caching the sheet in the browser failed", e);
    return false;
  }
}

function cacheRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn("browser storage unavailable", e);
  }
}

/** The cached sheet, or an empty one. */
function loadCache(): Sheet {
  const raw = cacheGet(CACHE_KEY);
  return (raw === null ? null : parseSheet(raw)) ?? emptySheet();
}

/** The sheet's savedAt as the app before BASE_KEY stamped it; 0 = none. */
function savedAt(sheet: Sheet): number {
  return sheet.savedAt ?? 0;
}

/**
 * The cache if the app wrote it before BASE_KEY existed and it had synced
 * since, else null. That app saved each edit at once and cached the sheets
 * it adopted, so the cache is the tasks.json it last synced with, short of
 * edits whose save failed: those stamped it newer than that tasks.json.
 */
function legacyCache(): string | null {
  if (cacheGet(BASE_KEY) !== null || cacheGet(UNSYNCED_KEY) !== null) {
    return null;
  }
  const raw = cacheGet(CACHE_KEY);
  const cached = raw === null ? null : parseSheet(raw);
  return cached !== null && savedAt(cached) > 0 ? raw : null;
}

/**
 * The sheet plus its sync to the server. The server's tasks.json is the
 * source of truth; localStorage is an offline cache. Every persistent
 * mutation funnels through `commit()`.
 *
 * Saves are conditional: a PUT names the tasks.json version (ETag) the
 * sheet was merged with, so one that missed another device's save gets a
 * 412 instead of overwriting it, and is merged with that save and retried.
 */
class SheetStore {
  sheet = $state<Sheet>(loadCache());
  status = $state<SyncStatus>("loading");
  /** id of the task being edited in place */
  editingId = $state<string | null>(null);
  /** a new note being typed; joins the sheet only once it has text */
  draft = $state<Task | null>(null);
  /** id of the task open in the detail pane; view state, never persisted */
  selectedId = $state<string | null>(null);
  /** the selected task, gone once it leaves the sheet */
  selected = $derived(this.sheet.tasks.find((t) => t.id === this.selectedId));

  /** the cache, if the app wrote it before BASE_KEY existed: see legacyCache */
  readonly #legacyCache = legacyCache();
  /**
   * tasks.json as last seen on the server, or a cache from before BASE_KEY
   * standing in for it; null = never seen, or none there
   */
  #lastServerText: string | null = cacheGet(BASE_KEY) ?? this.#legacyCache;
  /** ETag of #lastServerText; null = none known, so only create (If-None-Match) */
  #etag: string | null = null;
  #writeTimer: number | undefined;
  /** a click's select waiting out the double-click window; see selectLater */
  #selectTimer: number | undefined;
  /** settles once our PUT in flight is answered; null = none in flight */
  #putting: Promise<void> | null = null;
  /** an edit turned the last pull away; ending the edit runs it */
  #pullHeld = false;

  #serialize(): string {
    return JSON.stringify($state.snapshot(this.sheet), null, 2);
  }

  /**
   * Caches the sheet together with the server text it descends from. When
   * the sheet can't be cached the base is left alone too: an old sheet with
   * a newer base would read the server's additions since as local deletions.
   * When the base can't be cached the sheet is dropped with it: a new sheet
   * with an older base would read every change synced since as local edits.
   */
  #persist(): void {
    if (!cacheSet(CACHE_KEY, this.#serialize())) return;
    if (this.#lastServerText === null) cacheRemove(BASE_KEY);
    else if (!cacheSet(BASE_KEY, this.#lastServerText)) {
      cacheRemove(CACHE_KEY);
      cacheRemove(BASE_KEY);
    }
  }

  commit(): void {
    this.#persist();
    clearTimeout(this.#writeTimer);
    this.#writeTimer = window.setTimeout(() => {
      this.#writeTimer = undefined;
      void this.#write(MAX_CONFLICT_RETRIES);
    }, WRITE_DELAY_MS);
  }

  /** Saves the sheet over the tasks.json version it was merged with. */
  async #write(retries: number): Promise<void> {
    // one PUT at a time: a second one would name the same version as the
    // first and get a 412 once that lands, so wait for its ETag instead
    while (this.#putting !== null) await this.#putting;
    const text = this.#serialize();
    if (text === this.#lastServerText) {
      this.status = "synced";
      return;
    }
    this.status = "saving";
    // the only keepalive request of ours in flight, so it has the quota alone
    const keepalive = new TextEncoder().encode(text).length < KEEPALIVE_LIMIT;
    const answer = Promise.withResolvers<undefined>();
    this.#putting = answer.promise;
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(this.#etag === null
            ? { "if-none-match": "*" }
            : { "if-match": this.#etag }),
        },
        body: text,
        keepalive,
      });
    } catch (e) {
      console.warn("server unreachable, sheet kept in browser", e);
      this.status = "offline";
      return;
    } finally {
      // waiting writes resume only after the answer is handled below: that
      // runs without an await up to the GET of a 412's merge
      this.#putting = null;
      answer.resolve(undefined);
    }
    if (res.status === 412) {
      // another device saved first: merge with its sheet, then save again
      if (retries > 0) {
        await this.#pull(retries - 1);
        return;
      }
      console.error("tasks.json kept changing during the save");
      this.status = "error";
      return;
    }
    if (!res.ok) {
      console.error(`saving the sheet failed: HTTP ${String(res.status)}`);
      this.status = "error";
      return;
    }
    this.#etag = res.headers.get("etag");
    this.#lastServerText = text;
    this.#persist();
    if (this.#serialize() !== text) {
      // the sheet changed while this PUT was in flight, and the write of
      // that change may have been skipped as matching the older server text
      await this.#write(retries);
      return;
    }
    this.status = "synced";
  }

  /** Pull tasks.json, merge it with the local sheet, push the result if it differs. */
  async sync(): Promise<void> {
    await this.#pull(MAX_CONFLICT_RETRIES);
  }

  async #pull(retries: number): Promise<void> {
    if (this.editingId !== null || this.draft !== null) {
      this.#pullHeld = true; // never yank a note mid-edit
      return;
    }
    this.#pullHeld = false;
    const base = this.#lastServerText;
    let res: Response;
    try {
      res = await fetch(ENDPOINT, { cache: "no-store" });
    } catch {
      this.status = "offline";
      return;
    }
    if (!res.headers.has("x-eisenpaper")) {
      this.status = "offline"; // not served by the eisenpaper server
      return;
    }
    if (res.status !== 404 && !res.ok) {
      this.status = "error";
      return;
    }
    let text: string | null;
    try {
      text = res.status === 404 ? null : await res.text();
    } catch {
      this.status = "offline"; // the connection dropped mid-body
      return;
    }
    // a save of ours landed while the GET was in flight: this response may
    // predate it, and taking its version would only fail our next If-Match
    if (this.#lastServerText !== base) return;
    if (text === null) {
      // no sheet on disk yet: ours becomes it
      this.#etag = null;
      this.#lastServerText = null;
      this.#persist();
      await this.#write(retries);
      return;
    }
    if (text === base) {
      // server unchanged since our last sync: push any local edits whose
      // save failed (#write reports "synced" when there are none)
      this.#etag = res.headers.get("etag");
      await this.#write(retries);
      return;
    }
    const remote = parseSheet(text);
    if (remote === null) {
      console.error(
        "tasks.json is not a valid sheet — keeping the current one",
      );
      this.status = "error";
      return;
    }
    // an edit may have begun while the GET was in flight; leave
    // #lastServerText alone so the next sync merges this sheet again
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- both may change during the awaits above
    if (this.editingId !== null || this.draft !== null) {
      this.#pullHeld = true;
      return;
    }
    let baseSheet = (base === null ? null : parseSheet(base)) ?? emptySheet();
    // a cache from before BASE_KEY stamped newer than tasks.json holds edits
    // whose save failed, on a base nobody kept: merge it as never synced, so
    // they survive, as they did when that app pushed it over tasks.json
    if (
      base !== null &&
      base === this.#legacyCache &&
      savedAt(baseSheet) > savedAt(remote)
    ) {
      baseSheet = emptySheet();
    }
    const merged = mergeSheets(baseSheet, $state.snapshot(this.sheet), remote);
    this.#etag = res.headers.get("etag");
    this.#lastServerText = text;
    if (sameJson(merged, remote)) {
      this.sheet = remote;
      this.#persist();
      this.status = "synced";
    } else {
      this.sheet = merged;
      this.#persist();
      await this.#write(retries);
    }
  }

  /** Initial sync plus window listeners; returns the teardown. */
  start(): () => void {
    const onFocus = (): void => void this.sync();
    const onVisibility = (): void => {
      if (
        document.visibilityState === "hidden" &&
        this.#writeTimer !== undefined
      ) {
        clearTimeout(this.#writeTimer);
        this.#writeTimer = undefined;
        void this.#write(MAX_CONFLICT_RETRIES);
      }
    };
    addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    void this.sync();
    return () => {
      removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  addDraft(x: number, y: number): void {
    this.editingId = null;
    this.draft = {
      id: newId(),
      text: "",
      ...clampPosition(x, y),
      done: false,
      created: Date.now(),
    };
  }

  startEdit(task: Task): void {
    this.draft = null;
    this.editingId = task.id;
  }

  finishEdit(task: Task, rawText: string): void {
    const text = rawText.trim();
    const isDraft = this.draft?.id === task.id;
    this.draft = null;
    this.editingId = null;
    if (isDraft) {
      if (text === "") {
        this.#resumePull();
        return;
      }
      this.sheet.tasks.push({ ...task, text });
    } else if (text === "") {
      this.#removeById(task.id);
    } else {
      task.text = text;
    }
    this.commit();
  }

  cancelEdit(): void {
    this.draft = null;
    this.editingId = null;
    this.#resumePull();
  }

  /** An edit that ended without a commit lets the pull it held back run. */
  #resumePull(): void {
    if (this.#pullHeld) void this.sync();
  }

  /** Live drag update; the caller commits once the drag ends. */
  move(task: Task, x: number, y: number): void {
    Object.assign(task, clampPosition(x, y));
  }

  toggleDone(task: Task): void {
    task.done = !task.done;
    if (task.done) task.doneAt = Date.now();
    else delete task.doneAt;
    this.commit();
  }

  remove(task: Task): void {
    this.#removeById(task.id);
    this.commit();
  }

  /** Drop from the schedule pane: a day and index, or null = backlog. */
  schedule(id: string, day: string | null, index: number): void {
    placeTask(this.sheet.tasks, id, day, index);
    this.commit();
  }

  /** Select `id`, or none; a later choice also drops a select from selectLater. */
  select(id: string | null): void {
    this.cancelSelect();
    this.selectedId = id;
  }

  /**
   * Select `id` after `ms`, unless a select (closing the pane too) or a
   * cancelSelect comes first: a click waits out the double-click window,
   * and must not undo what the user did in it.
   */
  selectLater(id: string, ms: number): void {
    this.cancelSelect();
    this.#selectTimer = window.setTimeout(() => {
      this.#selectTimer = undefined;
      this.selectedId = id;
    }, ms);
  }

  /** Drop the select waiting in selectLater, if any. */
  cancelSelect(): void {
    clearTimeout(this.#selectTimer);
    this.#selectTimer = undefined;
  }

  /** File `task` under a project, or under none when `projectId` is null. */
  setProject(task: Task, projectId: string | null): void {
    if (projectId === null) delete task.project;
    else task.project = projectId;
    this.commit();
  }

  /** An emptied note is dropped; anything else is kept as typed. */
  setNote(task: Task, note: string): void {
    if (note === "") delete task.note;
    else task.note = note;
    this.commit();
  }

  /** Project names are unique ignoring case; blank or taken names are refused. */
  #nameFree(name: string, except?: string): boolean {
    const key = name.toLocaleLowerCase();
    return (
      name !== "" &&
      !(this.sheet.projects ?? []).some(
        (p) => p.id !== except && p.name.toLocaleLowerCase() === key,
      )
    );
  }

  /** Returns the new project's id, or null when the name is blank or taken. */
  addProject(rawName: string): string | null {
    const name = rawName.trim();
    if (!this.#nameFree(name)) return null;
    const id = newId();
    const projects = (this.sheet.projects ??= []);
    projects.push({ id, name, color: nextProjectColor(projects) });
    this.commit();
    return id;
  }

  /** Returns false when the name is blank or taken by another project. */
  renameProject(id: string, rawName: string): boolean {
    const name = rawName.trim();
    const project = this.sheet.projects?.find((p) => p.id === id);
    if (project === undefined || !this.#nameFree(name, id)) return false;
    project.name = name;
    this.commit();
    return true;
  }

  /** Any CSS colour; null makes the project colourless again. */
  setProjectColor(id: string, color: string | null): void {
    const project = this.sheet.projects?.find((p) => p.id === id);
    if (project === undefined) return;
    if (color === null) delete project.color;
    else project.color = color;
    this.commit();
  }

  /** Deletes a project; its open-sheet tasks keep going, without a project. */
  removeProject(id: string): void {
    this.sheet.projects = (this.sheet.projects ?? []).filter(
      (p) => p.id !== id,
    );
    for (const t of this.sheet.tasks) if (t.project === id) delete t.project;
    this.commit();
  }

  #removeById(id: string): void {
    this.sheet.tasks = this.sheet.tasks.filter((t) => t.id !== id);
  }

  /** Returns how many tasks were archived (0 = nothing crossed out). */
  freshSheet(): number {
    const before = this.sheet.tasks.length;
    const next = freshSheet($state.snapshot(this.sheet), Date.now());
    if (next === null) return 0;
    this.sheet = next;
    this.commit();
    return before - next.tasks.length;
  }

  replace(sheet: Sheet): void {
    this.cancelEdit();
    this.sheet = sheet;
    this.commit();
  }

  exportText(): string {
    return this.#serialize();
  }
}

export const store = new SheetStore();
