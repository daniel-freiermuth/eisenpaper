import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { parseSheet, type Sheet, type Task } from "./model";
import type { store as sheetStore } from "./sheet.svelte";

type Store = typeof sheetStore;

const serverTask: Task = {
  id: "t1",
  text: "file tax return",
  x: 0.5,
  y: 0.5,
  done: false,
  created: 1,
};
const serverSheet: Sheet = { tasks: [serverTask], archive: [], savedAt: 10 };
const serverText = JSON.stringify(serverSheet, null, 2);

const reply = (status: number, body = ""): Response =>
  new Response(status === 204 ? null : body, {
    status,
    headers: { "x-eisenpaper": "1" },
  });

type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** GET answers with a fresh `get()`; PUT answers with `putStatus`. */
const serve =
  (get: () => Response, putStatus = 204): Fetch =>
  (_url, init) =>
    Promise.resolve(init?.method === "PUT" ? reply(putStatus) : get());

/** GET serves `serverText`; PUT answers with `putStatus`. */
const server = (putStatus: number): Fetch =>
  serve(() => reply(200, serverText), putStatus);

const CACHE_KEY = "eisenpaper.v1";

/** The browser copy, distinct from `serverSheet`; `savedAt` decides who wins. */
const localText = (savedAt: number): string =>
  JSON.stringify(
    {
      tasks: [
        {
          id: "t2",
          text: "call the plumber",
          x: 0.2,
          y: 0.3,
          done: false,
          created: 2,
        },
      ],
      archive: [],
      savedAt,
    },
    null,
    2,
  );

let storage: Map<string, string>;

let fetchMock: Mock<typeof fetch>;

const puts = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");

const putBodies = (): unknown[] =>
  puts().map(([, init]) => JSON.parse(init?.body as string) as unknown);

async function loadStore() {
  // the store is a module singleton that reads localStorage on load, so each
  // test needs a fresh module evaluated after the globals are stubbed
  vi.resetModules();
  return (await import("./sheet.svelte")).store;
}

beforeEach(() => {
  vi.useFakeTimers();
  storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal("window", globalThis);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SheetStore.sync", () => {
  it("pushes an edit whose save failed offline once the server is back", async () => {
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();
    expect(store.status).toBe("synced");

    fetchMock.mockRejectedValue(new TypeError("network down"));
    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("server sheet not adopted");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.status).toBe("offline");

    fetchMock.mockReset();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(putBodies()).toMatchObject([{ tasks: [{ id: "t1", done: true }] }]);
    expect(store.status).toBe("synced");
  });

  it("retries a push that the server rejected", async () => {
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();
    store.replace({ tasks: [], archive: [] }); // local edit, newer than the server
    fetchMock.mockReset();
    fetchMock.mockImplementation(server(500));
    await store.sync();
    expect(store.status).toBe("error");

    fetchMock.mockReset();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(putBodies()).toMatchObject([{ tasks: [] }]);
    expect(store.status).toBe("synced");
  });

  it("never pushes to an origin that is not the eisenpaper server", async () => {
    storage.set(CACHE_KEY, localText(99)); // would win a reconcile
    const store = await loadStore();
    fetchMock.mockResolvedValue(new Response(serverText, { status: 200 }));
    await store.sync();

    expect(store.status).toBe("offline");
    expect(puts()).toHaveLength(0);
    expect(store.exportText()).toBe(localText(99));
  });

  it("keeps the browser copy when the server is unreachable", async () => {
    storage.set(CACHE_KEY, localText(5));
    const store = await loadStore();
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();

    expect(store.status).toBe("offline");
    expect(store.exportText()).toBe(localText(5));
    expect(storage.get(CACHE_KEY)).toBe(localText(5));
  });

  it("creates tasks.json from the local sheet when the server has none", async () => {
    storage.set(CACHE_KEY, localText(5));
    const store = await loadStore();
    fetchMock.mockImplementation(serve(() => reply(404)));
    await store.sync();

    expect(puts().map(([, init]) => init?.body)).toEqual([localText(5)]);
    expect(store.status).toBe("synced");
  });

  it("keeps the local sheet when tasks.json is not a valid sheet", async () => {
    storage.set(CACHE_KEY, localText(5));
    const store = await loadStore();
    const corrupt = JSON.stringify({ tasks: "nope", archive: [], savedAt: 99 });
    fetchMock.mockImplementation(serve(() => reply(200, corrupt)));
    await store.sync();

    expect(store.status).toBe("error");
    expect(store.exportText()).toBe(localText(5));
    expect(storage.get(CACHE_KEY)).toBe(localText(5));
    expect(puts()).toHaveLength(0);
  });

  it("neither adopts nor pushes when the server fails", async () => {
    storage.set(CACHE_KEY, localText(5)); // older than the body below
    const store = await loadStore();
    fetchMock.mockImplementation(serve(() => reply(500, serverText)));
    await store.sync();

    expect(store.status).toBe("error");
    expect(store.exportText()).toBe(localText(5));
    expect(puts()).toHaveLength(0);
  });

  it("does not save over a sheet the server failed to read", async () => {
    storage.set(CACHE_KEY, localText(5)); // a device that has synced before
    const store = await loadStore();
    fetchMock.mockImplementation(serve(() => reply(500)));
    await store.sync();
    expect(store.status).toBe("error");

    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("cached sheet not loaded");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);

    expect(puts()).toHaveLength(0);
    expect(store.status).toBe("error");

    // once tasks.json is readable again the edit is weighed against it
    fetchMock.mockReset();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(putBodies()).toMatchObject([{ tasks: [{ id: "t2", done: true }] }]);
    expect(store.status).toBe("synced");
  });

  it("adopts a newer server sheet and caches it for the next reload", async () => {
    storage.set(CACHE_KEY, localText(5)); // server savedAt is 10
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(store.status).toBe("synced");
    expect(JSON.parse(store.exportText())).toEqual(serverSheet);
    expect(storage.get(CACHE_KEY)).toBe(serverText);
    expect(puts()).toHaveLength(0);
  });

  it("pushes a strictly newer local sheet exactly once", async () => {
    storage.set(CACHE_KEY, localText(20)); // server savedAt is 10
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(puts().map(([, init]) => init?.body)).toEqual([localText(20)]);
    expect(store.status).toBe("synced");

    // the server now holds what we pushed: nothing left to send
    fetchMock.mockImplementation(serve(() => reply(200, localText(20))));
    await store.sync();

    expect(puts()).toHaveLength(1);
    expect(store.status).toBe("synced");
  });

  it("pushes again when an older sheet replaced the one we pushed", async () => {
    storage.set(CACHE_KEY, localText(20)); // server savedAt is 10
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();
    expect(puts()).toHaveLength(1);

    // a tab with an older savedAt overwrote tasks.json after our push, so the
    // server serves serverText again: ours must go back over it
    await store.sync();

    expect(puts().map(([, init]) => init?.body)).toEqual([
      localText(20),
      localText(20),
    ]);
    expect(store.status).toBe("synced");
  });

  it("does not touch the server while a task is being edited", async () => {
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    store.startEdit(serverTask);
    await store.sync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.status).toBe("loading");
  });

  it("does not touch the server while a new note is being typed", async () => {
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    store.addDraft(0.5, 0.5);
    await store.sync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.status).toBe("loading");
  });

  it("never overwrites the server with a sheet that never saw it", async () => {
    const store = await loadStore(); // empty cache: a new device
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();
    expect(store.status).toBe("offline");

    store.addDraft(0.2, 0.2);
    const draft = store.draft;
    if (draft === null) throw new Error("no draft");
    store.finishEdit(draft, "buy milk");
    await vi.advanceTimersByTimeAsync(300);

    fetchMock.mockReset();
    fetchMock.mockImplementation(server(204));
    await store.sync();
    await vi.advanceTimersByTimeAsync(300);

    expect(putBodies()).toMatchObject([
      { tasks: [{ id: "t1" }, { text: "buy milk" }] },
    ]);
    expect(store.sheet.tasks.map((t) => t.text)).toEqual([
      "file tax return",
      "buy milk",
    ]);
  });

  it("does not save blind once the server is back before any sync", async () => {
    const store = await loadStore(); // empty cache: a new device
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();

    fetchMock.mockReset();
    fetchMock.mockImplementation(server(204));
    store.addDraft(0.2, 0.2);
    const draft = store.draft;
    if (draft === null) throw new Error("no draft");
    store.finishEdit(draft, "buy milk");
    await vi.advanceTimersByTimeAsync(600);

    expect(putBodies()).toMatchObject([
      { tasks: [{ id: "t1" }, { text: "buy milk" }] },
    ]);
  });

  it("merges a backup imported before the first sync into a sheet it can read back", async () => {
    const backup: Sheet = {
      tasks: [{ ...serverTask, project: "p1" }],
      archive: [{ at: 5, tasks: [{ ...serverTask, id: "t0", done: true }] }],
      projects: [{ id: "p1", name: "taxes" }],
      savedAt: 10,
    };
    const backupText = JSON.stringify(backup, null, 2);
    const store = await loadStore(); // empty cache: a new device
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();

    const imported = parseSheet(backupText); // what Toolbar's import does
    if (imported === null) throw new Error("backup does not parse");
    store.replace(imported);
    await vi.advanceTimersByTimeAsync(300);

    fetchMock.mockReset();
    fetchMock.mockImplementation(serve(() => reply(200, backupText)));
    await store.sync();
    await vi.advanceTimersByTimeAsync(300);

    const bodies = puts().map(([, init]) => init?.body as string);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(parseSheet(body)).toMatchObject({
        tasks: [{ id: "t1" }],
        archive: [{ at: 5 }],
        projects: [{ id: "p1" }],
      });
    }
    expect(parseSheet(storage.get(CACHE_KEY) ?? "")).not.toBeNull();
    expect(store.sheet.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("does not yank a note whose edit began while the GET was in flight", async () => {
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();
    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("server sheet not adopted");

    let resolveGet: (res: Response) => void = () => undefined;
    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => (resolveGet = resolve)),
    );
    const pending = store.sync();
    store.startEdit(task);
    resolveGet(
      reply(200, JSON.stringify({ tasks: [], archive: [], savedAt: 20 })),
    );
    await pending;

    expect(store.sheet.tasks.map((t) => t.id)).toContain("t1");
    expect(store.editingId).toBe("t1");

    // the newer sheet is adopted by the first sync after the edit ends
    store.cancelEdit();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      reply(200, JSON.stringify({ tasks: [], archive: [], savedAt: 20 })),
    );
    await store.sync();
    expect(store.sheet.tasks).toEqual([]);
  });
});

/** A store that has adopted `serverSheet`, with the fetch log cleared. */
async function syncedStore() {
  const store = await loadStore();
  fetchMock.mockImplementation(server(204));
  await store.sync();
  expect(store.status).toBe("synced");
  fetchMock.mockClear();
  return store;
}

function firstTask(store: { sheet: Sheet }): Task {
  const task = store.sheet.tasks[0];
  if (task === undefined) throw new Error("server sheet not adopted");
  return task;
}

describe("SheetStore.commit", () => {
  it("coalesces commits within the write delay into one PUT of the final state", async () => {
    const store = await syncedStore();
    const task = firstTask(store);

    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(200);
    store.finishEdit(task, "file tax return today"); // re-arms the delay
    await vi.advanceTimersByTimeAsync(299);
    expect(puts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(putBodies()).toMatchObject([
      { tasks: [{ id: "t1", done: true, text: "file tax return today" }] },
    ]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(puts()).toHaveLength(1);
    expect(store.status).toBe("synced");
  });

  it("stamps savedAt and caches the sheet at once, even when the PUT fails", async () => {
    const store = await syncedStore();
    fetchMock.mockImplementation(server(500));
    vi.setSystemTime(1234);

    store.toggleDone(firstTask(store));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.sheet.savedAt).toBe(1234);
    const cached = (): unknown => JSON.parse(storage.get(CACHE_KEY) ?? "null");
    expect(cached()).toMatchObject({
      savedAt: 1234,
      tasks: [{ id: "t1", done: true }],
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(puts()).toHaveLength(1);
    expect(store.status).toBe("error");
    expect(cached()).toMatchObject({
      savedAt: 1234,
      tasks: [{ id: "t1", done: true }],
    });
  });

  /** Like `server(204)`, but rejects a keepalive PUT over the browsers'
   * 64 KiB keepalive body quota, which counts UTF-8 bytes. */
  const keepaliveQuota: Fetch = (url, init) =>
    init?.keepalive === true &&
    new TextEncoder().encode(init.body as string).length > 65_536
      ? Promise.reject(new TypeError("keepalive body over 64 KiB"))
      : server(204)(url, init);

  it("saves a sheet whose UTF-8 body exceeds the keepalive quota", async () => {
    const store = await loadStore();
    fetchMock.mockImplementation(keepaliveQuota);
    await store.sync();

    // ~40k UTF-16 code units, but ~120k UTF-8 bytes
    const text = "締め切り".repeat(10_000);
    store.replace({ tasks: [{ ...serverTask, text }], archive: [] });
    await vi.advanceTimersByTimeAsync(300);

    expect(store.exportText().length).toBeLessThan(60_000);
    expect(putBodies()).toMatchObject([{ tasks: [{ text }] }]);
    expect(store.status).toBe("synced");
  });
});

describe("SheetStore.start", () => {
  let win: EventTarget;
  let doc: EventTarget & { visibilityState: DocumentVisibilityState };

  beforeEach(() => {
    win = new EventTarget();
    vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
    vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
    doc = Object.assign<
      EventTarget,
      { visibilityState: DocumentVisibilityState }
    >(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", doc);
  });

  const setVisibility = (state: DocumentVisibilityState): void => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };

  /** A started store that has finished its initial sync. */
  async function startedStore() {
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    const stop = store.start();
    await vi.waitFor(() => {
      expect(store.status).toBe("synced");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the initial GET
    fetchMock.mockClear();
    return { store, stop };
  }

  it("flushes a pending write the moment the page is hidden, and only once", async () => {
    const { store } = await startedStore();
    store.toggleDone(firstTask(store));
    // the flushed PUT is still in flight when the debounce delay runs out
    let resolvePut: (res: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => (resolvePut = resolve)),
    );

    setVisibility("hidden");
    expect(putBodies()).toMatchObject([{ tasks: [{ id: "t1", done: true }] }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(puts()).toHaveLength(1);
    resolvePut(reply(204));
    await vi.waitFor(() => {
      expect(store.status).toBe("synced");
    });
    expect(puts()).toHaveLength(1);
  });

  it("does not write on hide when no write is pending", async () => {
    const { store } = await startedStore();
    setVisibility("hidden");
    expect(fetchMock).not.toHaveBeenCalled();

    // once the debounced write has gone out, hiding has nothing to flush;
    // a failed save is retried by the next sync, not by every tab switch
    setVisibility("visible");
    fetchMock.mockImplementation(server(500));
    store.toggleDone(firstTask(store));
    await vi.advanceTimersByTimeAsync(300);
    expect(puts()).toHaveLength(1);
    expect(store.status).toBe("error");

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts()).toHaveLength(1);
  });

  it("leaves a pending write on its timer when the page becomes visible", async () => {
    const { store } = await startedStore();
    store.toggleDone(firstTask(store));

    setVisibility("visible");
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toMatchObject([{ tasks: [{ id: "t1", done: true }] }]);
  });

  it("re-syncs with the server when the window regains focus", async () => {
    const { store } = await startedStore();
    win.dispatchEvent(new Event("focus"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined(); // a GET
    await vi.waitFor(() => {
      expect(store.status).toBe("synced");
    });
  });

  it("stops reacting to focus and hide once torn down", async () => {
    const { store, stop } = await startedStore();
    stop();

    win.dispatchEvent(new Event("focus"));
    store.toggleDone(firstTask(store));
    setVisibility("hidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SheetStore edit lifecycle", () => {
  const plumber: Task = {
    id: "t2",
    text: "call the plumber",
    x: 0.2,
    y: 0.3,
    done: false,
    created: 2,
  };
  const cachedText = JSON.stringify(
    { tasks: [serverTask, plumber], archive: [], savedAt: 5 },
    null,
    2,
  );

  /** A store loaded from its cache, so not unsynced: every commit PUTs directly. */
  async function editingStore() {
    storage.set(CACHE_KEY, cachedText);
    vi.setSystemTime(1000);
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    return store;
  }

  function sheetTask(store: Store, id: string): Task {
    const task = store.sheet.tasks.find((t) => t.id === id);
    if (task === undefined) throw new Error(`no task ${id}`);
    return task;
  }

  /** Nothing committed: sheet, cache and server all as loaded. */
  async function expectUncommitted(store: Store): Promise<void> {
    await vi.advanceTimersByTimeAsync(300);
    expect(store.exportText()).toBe(cachedText);
    expect(storage.get(CACHE_KEY)).toBe(cachedText);
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it.each(["", "  \n\t "])(
    "drops a draft finished with no text without saving (%j)",
    async (text) => {
      const store = await editingStore();
      store.addDraft(0.5, 0.5);
      const draft = store.draft;
      if (draft === null) throw new Error("no draft");
      store.finishEdit(draft, text);

      expect(store.draft).toBeNull();
      expect(store.editingId).toBeNull();
      await expectUncommitted(store);
    },
  );

  it("appends a finished draft with its text trimmed and saves it", async () => {
    const store = await editingStore();
    store.addDraft(0.4, 0.6);
    const draft = store.draft;
    if (draft === null) throw new Error("no draft");
    vi.setSystemTime(2000);
    store.finishEdit(draft, "  buy milk \n");

    expect(store.draft).toBeNull();
    expect(store.editingId).toBeNull();
    const added = { id: draft.id, text: "buy milk", x: 0.4, y: 0.6 };
    expect(store.sheet.tasks).toMatchObject([
      { id: "t1" },
      { id: "t2" },
      added,
    ]);
    expect(store.sheet.savedAt).toBe(2000);
    expect(storage.get(CACHE_KEY)).toBe(store.exportText());

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toMatchObject([
      { tasks: [{ id: "t1" }, { id: "t2" }, added], savedAt: 2000 },
    ]);
  });

  it("removes only the note whose text was emptied, and saves that", async () => {
    const store = await editingStore();
    const task = sheetTask(store, "t2");
    store.startEdit(task);
    vi.setSystemTime(2000);
    store.finishEdit(task, " \n ");

    expect(store.editingId).toBeNull();
    expect(store.sheet.tasks).toEqual([serverTask]);
    expect(store.sheet.savedAt).toBe(2000);

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toEqual([
      { tasks: [serverTask], archive: [], savedAt: 2000 },
    ]);
  });

  it("updates an edited note in place with its text trimmed", async () => {
    const store = await editingStore();
    const task = sheetTask(store, "t2");
    store.startEdit(task);
    vi.setSystemTime(2000);
    store.finishEdit(task, "\tcall the plumber today  ");

    expect(store.editingId).toBeNull();
    const edited = { ...plumber, text: "call the plumber today" };
    expect(store.sheet.tasks).toEqual([serverTask, edited]);

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toEqual([
      { tasks: [serverTask, edited], archive: [], savedAt: 2000 },
    ]);
  });

  it("cancels a draft without adding or saving anything", async () => {
    const store = await editingStore();
    store.addDraft(0.5, 0.5);
    store.cancelEdit();

    expect(store.draft).toBeNull();
    await expectUncommitted(store);
  });

  it("cancels editing a note without changing or saving anything", async () => {
    const store = await editingStore();
    store.startEdit(sheetTask(store, "t2"));
    store.cancelEdit();

    expect(store.editingId).toBeNull();
    await expectUncommitted(store);
  });

  it("clamps a new draft into the pane and ends any edit in progress", async () => {
    const store = await editingStore();
    store.startEdit(sheetTask(store, "t2"));
    store.addDraft(-1, 2);

    expect(store.editingId).toBeNull();
    expect(store.draft).toMatchObject({
      text: "",
      x: 0.02,
      y: 0.97,
      done: false,
    });
    expect(store.draft?.id).not.toBe("t2");
    await expectUncommitted(store);
  });
});

describe("SheetStore projects", () => {
  it("keeps the projects of both sides when merging a never-synced sheet", async () => {
    const store = await loadStore(); // empty cache: a new device
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();
    store.addProject("garden");

    const remote: Sheet = {
      ...serverSheet,
      projects: [{ id: "p1", name: "taxes" }],
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      serve(() => reply(200, JSON.stringify(remote))),
    );
    await store.sync();

    expect(store.sheet.projects?.map((p) => p.name)).toEqual([
      "taxes",
      "garden",
    ]);
  });

  it("refuses blank names and names taken in any letter case", async () => {
    const store = await loadStore();
    expect(store.addProject("Garden")).not.toBeNull();
    const work = store.addProject("work");
    if (work === null) throw new Error("work refused");

    expect(store.addProject("  garden ")).toBeNull();
    expect(store.addProject("   ")).toBeNull();
    expect(store.renameProject(work, "GARDEN")).toBe(false);
    expect(store.renameProject(work, " Work ")).toBe(true);
    expect(store.sheet.projects?.map((p) => p.name)).toEqual([
      "Garden",
      "Work",
    ]);
  });

  it("unassigns a deleted project's tasks and leaves the others", async () => {
    const store = await loadStore();
    const garden = store.addProject("garden");
    const work = store.addProject("work");
    if (garden === null || work === null) throw new Error("project refused");
    for (const text of ["weed", "report"]) {
      store.addDraft(0.5, 0.5);
      const draft = store.draft;
      if (draft === null) throw new Error("no draft");
      store.finishEdit(draft, text);
    }
    const [weed, report] = store.sheet.tasks;
    if (weed === undefined || report === undefined) throw new Error("no tasks");
    store.setProject(weed, garden);
    store.setProject(report, work);

    store.removeProject(garden);

    expect(store.sheet.projects?.map((p) => p.id)).toEqual([work]);
    expect(store.sheet.tasks.map((t) => t.project)).toEqual([undefined, work]);
  });
});
