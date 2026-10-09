import {
  clampPosition,
  emptySheet,
  freshSheet,
  newId,
  parseSheet,
  reconcile,
  type Sheet,
  type Task,
} from "./model";

export type SyncStatus = "loading" | "synced" | "saving" | "offline" | "error";

const CACHE_KEY = "eisenpaper.v1";
const ENDPOINT = "tasks.json";
const WRITE_DELAY_MS = 300;
/** browsers cap keepalive request bodies at 64 KiB */
const KEEPALIVE_LIMIT = 60_000;

function loadCache(): Sheet {
  const raw = localStorage.getItem(CACHE_KEY);
  return (raw === null ? null : parseSheet(raw)) ?? emptySheet();
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
        keepalive: text.length < KEEPALIVE_LIMIT,
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
      this.#lastServerText = null; // no sheet on disk yet — create it
      await this.#write();
      return;
    }
    if (!res.ok) {
      this.status = "error";
      return;
    }
    const text = await res.text();
    if (text === this.#lastServerText) {
      this.status = "synced";
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
    this.#lastServerText = text;
    if (reconcile(this.sheet, remote) === "adopt") {
      this.sheet = remote;
      localStorage.setItem(CACHE_KEY, text);
      this.status = "synced";
    } else {
      await this.#write();
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
