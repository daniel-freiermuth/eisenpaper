import {
  clampPosition,
  emptySheet,
  freshSheet,
  newId,
  nextProjectColor,
  parseSheet,
  reconcile,
  type Sheet,
  type Task,
} from "./model";
import { placeTask } from "./schedule";

export type SyncStatus = "loading" | "synced" | "saving" | "offline" | "error";

const CACHE_KEY = "eisenpaper.v1";
/** set while the cached sheet has never been reconciled with tasks.json */
const UNSYNCED_KEY = "eisenpaper.v1.unsynced";
const ENDPOINT = "tasks.json";
const WRITE_DELAY_MS = 300;
/** browsers cap keepalive request bodies at 64 KiB (of UTF-8, not UTF-16) */
const KEEPALIVE_LIMIT = 60_000;

/** The cached sheet, or an empty one that is flagged as never synced. */
function loadCache(): Sheet {
  const raw = localStorage.getItem(CACHE_KEY);
  const cached = raw === null ? null : parseSheet(raw);
  if (cached !== null) return cached;
  localStorage.setItem(UNSYNCED_KEY, "1");
  return emptySheet();
}

/**
 * The sheet plus its sync to the server. The server's tasks.json is the
 * source of truth; localStorage is an offline cache. Every persistent
 * mutation funnels through `commit()`.
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

  /** never reconciled with tasks.json, so no base to overwrite it with */
  #unsynced = localStorage.getItem(UNSYNCED_KEY) !== null;
  /** the last GET failed, so tasks.json may hold edits we have not seen */
  #serverFailed = false;
  #lastServerText: string | null = null;
  #writeTimer: number | undefined;

  #serialize(): string {
    return JSON.stringify($state.snapshot(this.sheet), null, 2);
  }

  commit(): void {
    this.sheet.savedAt = Date.now();
    localStorage.setItem(CACHE_KEY, this.#serialize());
    clearTimeout(this.#writeTimer);
    this.#writeTimer = window.setTimeout(() => {
      this.#writeTimer = undefined;
      void this.#write();
    }, WRITE_DELAY_MS);
  }

  async #write(): Promise<void> {
    if (this.#unsynced || this.#serverFailed) {
      await this.sync(); // merges into the server's sheet first
      return;
    }
    const text = this.#serialize();
    if (text === this.#lastServerText) {
      this.status = "synced";
      return;
    }
    this.status = "saving";
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: text,
        keepalive: new TextEncoder().encode(text).length < KEEPALIVE_LIMIT,
      });
      if (!res.ok) {
        console.error(`saving the sheet failed: HTTP ${String(res.status)}`);
        this.status = "error";
        return;
      }
      this.#lastServerText = text;
      this.status = "synced";
    } catch (e) {
      console.warn("server unreachable, sheet kept in browser", e);
      this.status = "offline";
    }
  }

  /** Pull tasks.json; adopt it if newer, otherwise push ours over it. */
  async sync(): Promise<void> {
    if (this.editingId !== null || this.draft !== null) return; // never yank a note mid-edit
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
    if (res.status === 404) {
      this.#serverFailed = false;
      this.#markSynced(); // nothing on the server to lose
      this.#lastServerText = null; // no sheet on disk yet — create it
      await this.#write();
      return;
    }
    if (!res.ok) {
      this.#serverFailed = true; // a sheet may exist: never save blind over it
      this.status = "error";
      return;
    }
    this.#serverFailed = false;
    const text = await res.text();
    if (text === this.#lastServerText) {
      // server unchanged since our last sync: push any local edits whose
      // save failed (#write reports "synced" when there are none)
      await this.#write();
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
    // #lastServerText alone so the next sync weighs this sheet again
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- both may change during the awaits above
    if (this.editingId !== null || this.draft !== null) return;
    this.#lastServerText = text;
    const unsynced = this.#unsynced;
    this.#markSynced();
    const local = $state.snapshot(this.sheet);
    if (
      unsynced &&
      (local.tasks.length > 0 ||
        local.archive.length > 0 ||
        (local.projects?.length ?? 0) > 0)
    ) {
      // everything here was written without ever seeing the server's
      // sheet: add it to that sheet rather than replace it. Keys the server
      // already has (an imported backup, another tab's merge) stay as the
      // server has them: the renderer and parseSheet reject duplicate keys.
      const taskIds = new Set(remote.tasks.map((t) => t.id));
      const archiveAts = new Set(remote.archive.map((a) => a.at));
      const remoteProjects = remote.projects ?? [];
      const projectIds = new Set(remoteProjects.map((p) => p.id));
      const projects = [
        ...remoteProjects,
        ...(local.projects ?? []).filter((p) => !projectIds.has(p.id)),
      ];
      this.sheet = {
        ...remote,
        tasks: [
          ...remote.tasks,
          ...local.tasks.filter((t) => !taskIds.has(t.id)),
        ],
        archive: [
          ...remote.archive,
          ...local.archive.filter((a) => !archiveAts.has(a.at)),
        ],
        ...(projects.length > 0 ? { projects } : {}),
      };
      this.commit();
    } else if (unsynced || reconcile(local, remote) === "adopt") {
      this.sheet = remote;
      localStorage.setItem(CACHE_KEY, text);
      this.status = "synced";
    } else {
      await this.#write();
    }
  }

  #markSynced(): void {
    this.#unsynced = false;
    localStorage.removeItem(UNSYNCED_KEY);
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
        void this.#write();
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
      if (text === "") return;
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

  select(id: string | null): void {
    this.selectedId = id;
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
