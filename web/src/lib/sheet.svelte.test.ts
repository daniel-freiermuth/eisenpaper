import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { Sheet, Task } from "./model";
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
const serverSheet: Sheet = { tasks: [serverTask], archive: [] };
const serverText = JSON.stringify(serverSheet, null, 2);
const emptyText = JSON.stringify({ tasks: [], archive: [] }, null, 2);

const reply = (
  status: number,
  body = "",
  headers: Record<string, string> = {},
): Response =>
  new Response(status === 204 ? null : body, {
    status,
    headers: { "x-eisenpaper": "1", ...headers },
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

/**
 * tasks.json behind the conditional-request protocol of src/main.rs: GET
 * sends an ETag, PUT needs If-Match with it (or If-None-Match: * while
 * there is no sheet) and gets 412 otherwise.
 */
function fakeServer(initial: string | null) {
  let text = initial;
  let version = 0;
  const tag = (): string => `"v${String(version)}"`;
  const handle: Fetch = (_url, init) => {
    if (init?.method !== "PUT") {
      return Promise.resolve(
        text === null ? reply(404) : reply(200, text, { etag: tag() }),
      );
    }
    const headers = new Headers(init.headers);
    const ifMatch = headers.get("if-match");
    const ifNoneMatch = headers.get("if-none-match");
    if (ifMatch === null && ifNoneMatch === null) {
      return Promise.resolve(reply(428));
    }
    const holds =
      ifMatch === null
        ? ifNoneMatch === "*" && text === null
        : text !== null && ifMatch === tag();
    if (!holds) return Promise.resolve(reply(412, "", { etag: tag() }));
    text = init.body as string;
    version += 1;
    return Promise.resolve(reply(204, "", { etag: tag() }));
  };
  return {
    handle,
    /** what tasks.json holds now */
    sheet: (): unknown => (text === null ? null : JSON.parse(text)),
    /** another device saves `sheet` */
    save(sheet: Sheet): void {
      text = JSON.stringify(sheet, null, 2);
      version += 1;
    },
  };
}

const CACHE_KEY = "eisenpaper.v1";
const BASE_KEY = "eisenpaper.v1.base";

/** A browser copy that never saw `serverSheet`. */
const localText = JSON.stringify(
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
    const tasks = fakeServer(serverText);
    const store = await loadStore();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();
    expect(store.status).toBe("synced");

    fetchMock.mockRejectedValue(new TypeError("network down"));
    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("server sheet not adopted");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.status).toBe("offline");

    fetchMock.mockReset();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    expect(putBodies()).toMatchObject([{ tasks: [{ id: "t1", done: true }] }]);
    expect(store.status).toBe("synced");
  });

  it("retries a push that the server rejected", async () => {
    const tasks = fakeServer(serverText);
    const store = await loadStore();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();
    store.replace({ tasks: [], archive: [] });
    fetchMock.mockReset();
    fetchMock.mockImplementation(server(500));
    await store.sync();
    expect(store.status).toBe("error");

    fetchMock.mockReset();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    expect(putBodies()).toMatchObject([{ tasks: [] }]);
    expect(tasks.sheet()).toMatchObject({ tasks: [] });
    expect(store.status).toBe("synced");
  });

  it("never pushes to an origin that is not the eisenpaper server", async () => {
    storage.set(CACHE_KEY, localText);
    const store = await loadStore();
    fetchMock.mockResolvedValue(new Response(serverText, { status: 200 }));
    await store.sync();

    expect(store.status).toBe("offline");
    expect(puts()).toHaveLength(0);
    expect(store.exportText()).toBe(localText);
  });

  it("keeps the browser copy when the server is unreachable", async () => {
    storage.set(CACHE_KEY, localText);
    const store = await loadStore();
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();

    expect(store.status).toBe("offline");
    expect(store.exportText()).toBe(localText);
    expect(storage.get(CACHE_KEY)).toBe(localText);
  });

  it("goes offline when the connection drops while reading tasks.json", async () => {
    storage.set(CACHE_KEY, localText);
    const store = await loadStore();
    const dropped = new ReadableStream({
      start(c) {
        c.error(new TypeError("network error"));
      },
    });
    fetchMock.mockResolvedValue(
      new Response(dropped, { status: 200, headers: { "x-eisenpaper": "1" } }),
    );
    await store.sync();

    expect(store.status).toBe("offline");
    expect(store.exportText()).toBe(localText);
    expect(puts()).toHaveLength(0);
  });

  it("creates tasks.json from the local sheet when the server has none", async () => {
    storage.set(CACHE_KEY, localText);
    const tasks = fakeServer(null);
    const store = await loadStore();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    expect(puts().map(([, init]) => init?.body)).toEqual([localText]);
    expect(tasks.sheet()).toEqual(JSON.parse(localText));
    expect(store.status).toBe("synced");
  });

  it("keeps the local sheet when tasks.json is not a valid sheet", async () => {
    storage.set(CACHE_KEY, localText);
    const store = await loadStore();
    const corrupt = JSON.stringify({ tasks: "nope", archive: [] });
    fetchMock.mockImplementation(serve(() => reply(200, corrupt)));
    await store.sync();

    expect(store.status).toBe("error");
    expect(store.exportText()).toBe(localText);
    expect(storage.get(CACHE_KEY)).toBe(localText);
    expect(puts()).toHaveLength(0);
  });

  it("neither adopts nor pushes when the server fails", async () => {
    storage.set(CACHE_KEY, localText);
    const store = await loadStore();
    fetchMock.mockImplementation(serve(() => reply(500, serverText)));
    await store.sync();

    expect(store.status).toBe("error");
    expect(store.exportText()).toBe(localText);
    expect(puts()).toHaveLength(0);
  });

  it("does not save over a tasks.json that is not a valid sheet", async () => {
    storage.set(CACHE_KEY, localText);
    storage.set(BASE_KEY, emptyText); // a device that has synced before
    const store = await loadStore();
    const corrupt = JSON.stringify({ tasks: "nope", archive: [] });
    // tasks.json exists and PUT checks against it, so only its ETag could
    // replace it, and that ETag is never adopted from an unreadable sheet
    const tasks = fakeServer(corrupt);
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();
    expect(store.status).toBe("error");

    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("cached sheet not loaded");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);

    expect(tasks.sheet()).toEqual(JSON.parse(corrupt));
    expect(store.status).toBe("error");
  });

  it("does not save over a sheet the server failed to read", async () => {
    storage.set(CACHE_KEY, localText);
    storage.set(BASE_KEY, emptyText); // a device that has synced before
    const store = await loadStore();
    const tasks = fakeServer(serverText);
    // GET fails, but tasks.json exists and PUT still checks against it
    fetchMock.mockImplementation((url, init) =>
      init?.method === "PUT"
        ? tasks.handle(url, init)
        : Promise.resolve(reply(500)),
    );
    await store.sync();
    expect(store.status).toBe("error");

    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("cached sheet not loaded");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);

    expect(tasks.sheet()).toEqual(serverSheet);
    expect(store.status).toBe("error");

    // once tasks.json is readable again the edit is merged into it
    fetchMock.mockReset();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    expect(tasks.sheet()).toMatchObject({
      tasks: [{ id: "t1" }, { id: "t2", done: true }],
    });
    expect(store.status).toBe("synced");
  });

  it("adopts the server sheet when nothing changed here, and caches it", async () => {
    storage.set(CACHE_KEY, emptyText);
    storage.set(BASE_KEY, emptyText); // last synced before t1 was added
    const store = await loadStore();
    fetchMock.mockImplementation(fakeServer(serverText).handle);
    await store.sync();

    expect(store.status).toBe("synced");
    expect(JSON.parse(store.exportText())).toEqual(serverSheet);
    expect(storage.get(CACHE_KEY)).toBe(serverText);
    expect(storage.get(BASE_KEY)).toBe(serverText);
    expect(puts()).toHaveLength(0);
  });

  it("pushes local edits merged into the server sheet exactly once", async () => {
    storage.set(CACHE_KEY, localText); // t2 added here...
    storage.set(BASE_KEY, emptyText);
    const tasks = fakeServer(serverText); // ...t1 added elsewhere
    const store = await loadStore();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    expect(tasks.sheet()).toMatchObject({
      tasks: [{ id: "t1" }, { id: "t2" }],
    });
    expect(store.status).toBe("synced");

    // the server now holds what we pushed: nothing left to send
    await store.sync();

    expect(puts()).toHaveLength(1);
    expect(store.status).toBe("synced");
  });

  it("merges another device's save instead of overwriting it", async () => {
    const tasks = fakeServer(serverText);
    const store = await loadStore(); // the desktop
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    // the phone adds a task; the focused desktop never pulls it
    const phoneTask = { ...serverTask, id: "phone", text: "buy milk" };
    tasks.save({ tasks: [serverTask, phoneTask], archive: [] });
    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("server sheet not adopted");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);

    expect(tasks.sheet()).toMatchObject({
      tasks: [
        { id: "t1", done: true },
        { id: "phone", text: "buy milk" },
      ],
    });
    expect(store.sheet.tasks.map((t) => t.id)).toEqual(["t1", "phone"]);
    expect(store.status).toBe("synced");
  });

  it("keeps offline edits across a reload when another device saved since", async () => {
    const tasks = fakeServer(serverText);
    let store = await loadStore(); // the phone
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    fetchMock.mockRejectedValue(new TypeError("network down"));
    const task = store.sheet.tasks[0];
    if (task === undefined) throw new Error("server sheet not adopted");
    store.toggleDone(task);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.status).toBe("offline");

    // the desktop edits later; then the phone reloads the app, back online
    const desktopTask = { ...serverTask, id: "desk", text: "renew passport" };
    tasks.save({ tasks: [serverTask, desktopTask], archive: [] });
    store = await loadStore();
    fetchMock.mockReset();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    expect(tasks.sheet()).toMatchObject({
      tasks: [{ id: "t1", done: true }, { id: "desk" }],
    });
    expect(store.status).toBe("synced");
  });

  it("does not bring back a task another device deleted", async () => {
    const tasks = fakeServer(serverText);
    const store = await loadStore();
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();

    tasks.save({ tasks: [], archive: [] }); // deleted on the phone
    store.addDraft(0.2, 0.2);
    const draft = store.draft;
    if (draft === null) throw new Error("no draft");
    store.finishEdit(draft, "buy milk");
    await vi.advanceTimersByTimeAsync(300);

    expect(tasks.sheet()).toMatchObject({ tasks: [{ text: "buy milk" }] });
    expect(store.sheet.tasks.map((t) => t.text)).toEqual(["buy milk"]);
  });

  it("gives up with an error when tasks.json changes on every save", async () => {
    const store = await loadStore();
    let n = 0;
    fetchMock.mockImplementation((_url, init) => {
      n += 1;
      if (init?.method === "PUT") return Promise.resolve(reply(412));
      const sheet = {
        tasks: [{ ...serverTask, text: String(n) }],
        archive: [],
      };
      return Promise.resolve(
        reply(200, JSON.stringify(sheet), { etag: `"${String(n)}"` }),
      );
    });
    await store.sync();
    store.replace({ tasks: [], archive: [], note: "mine" });
    await vi.advanceTimersByTimeAsync(300);

    expect(store.status).toBe("error");
    expect(puts()).toHaveLength(4); // the save plus three merges
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
    const tasks = fakeServer(serverText);
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
    fetchMock.mockImplementation(tasks.handle);
    await store.sync();
    await vi.advanceTimersByTimeAsync(300);

    expect(tasks.sheet()).toMatchObject({
      tasks: [{ id: "t1" }, { text: "buy milk" }],
    });
    expect(store.sheet.tasks.map((t) => t.text)).toEqual([
      "file tax return",
      "buy milk",
    ]);
  });

  it("does not save blind once the server is back before any sync", async () => {
    const tasks = fakeServer(serverText);
    const store = await loadStore(); // empty cache: a new device
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await store.sync();

    fetchMock.mockReset();
    fetchMock.mockImplementation(tasks.handle);
    store.addDraft(0.2, 0.2);
    const draft = store.draft;
    if (draft === null) throw new Error("no draft");
    store.finishEdit(draft, "buy milk");
    await vi.advanceTimersByTimeAsync(600);

    expect(tasks.sheet()).toMatchObject({
      tasks: [{ id: "t1" }, { text: "buy milk" }],
    });
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
    resolveGet(reply(200, emptyText)); // t1 was deleted elsewhere
    await pending;

    expect(store.sheet.tasks.map((t) => t.id)).toContain("t1");
    expect(store.editingId).toBe("t1");

    // the deletion is adopted by the first sync after the edit ends
    store.cancelEdit();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(200, emptyText));
    await store.sync();
    expect(store.sheet.tasks).toEqual([]);
  });
});

describe("SheetStore without a usable localStorage", () => {
  const quotaExceeded = (): never => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  };

  it("still loads when the browser blocks storage", async () => {
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Access is denied", "SecurityError");
      },
    });
    const store = await loadStore();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(store.status).toBe("synced");
    expect(JSON.parse(store.exportText())).toEqual(serverSheet);
  });

  it("still saves to the server when the browser copy cannot be written", async () => {
    const store = await syncedStore();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: quotaExceeded,
      removeItem: (k: string) => storage.delete(k),
    });
    store.replace({ tasks: [], archive: [] });
    await vi.advanceTimersByTimeAsync(300);

    expect(putBodies()).toMatchObject([{ tasks: [], archive: [] }]);
    expect(store.status).toBe("synced");
  });

  it("finishes adopting a server sheet that cannot be cached", async () => {
    const store = await loadStore();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: quotaExceeded,
      removeItem: (k: string) => storage.delete(k),
    });
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(store.status).toBe("synced");
    expect(JSON.parse(store.exportText())).toEqual(serverSheet);
  });

  it("keeps another device's task when only the base could be cached", async () => {
    let cacheFull = false;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (cacheFull && k === CACHE_KEY) quotaExceeded();
        storage.set(k, v);
      },
      removeItem: (k: string) => storage.delete(k),
    });
    const tasks = fakeServer(serverText);
    fetchMock.mockImplementation(tasks.handle);
    const store = await loadStore();
    await store.sync();

    // another device adds a task; this tab adopts it but can't cache it
    const added: Task = { ...serverTask, id: "t3", text: "water plants" };
    tasks.save({ tasks: [serverTask, added], archive: [] });
    cacheFull = true;
    await store.sync();

    cacheFull = false;
    const reloaded = await loadStore();
    await reloaded.sync();

    expect(tasks.sheet()).toMatchObject({
      tasks: [{ id: "t1" }, { id: "t3" }],
    });
    expect(reloaded.sheet.tasks.map((t) => t.id)).toEqual(["t1", "t3"]);
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

  it("caches the sheet at once, even when the PUT fails", async () => {
    const store = await syncedStore();
    fetchMock.mockImplementation(server(500));

    store.toggleDone(firstTask(store));

    expect(fetchMock).not.toHaveBeenCalled();
    const cached = (): unknown => JSON.parse(storage.get(CACHE_KEY) ?? "null");
    expect(cached()).toMatchObject({ tasks: [{ id: "t1", done: true }] });

    await vi.advanceTimersByTimeAsync(300);
    expect(puts()).toHaveLength(1);
    expect(store.status).toBe("error");
    expect(cached()).toMatchObject({ tasks: [{ id: "t1", done: true }] });
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

  it("keeps overlapping keepalive PUTs within the shared 64 KiB quota", async () => {
    const { store } = await startedStore();
    // browsers sum the bodies of every keepalive request still in flight
    let inFlight = 0;
    const held: (() => void)[] = [];
    const accepted: string[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const body = init?.body as string;
      const bytes = init?.keepalive === true ? body.length : 0; // ASCII body
      if (inFlight + bytes > 65_536)
        return Promise.reject(new TypeError("keepalive quota exceeded"));
      inFlight += bytes;
      return new Promise<Response>((resolve) =>
        held.push(() => {
          inFlight -= bytes;
          accepted.push(body);
          resolve(reply(204));
        }),
      );
    });

    // a ~40 KB sheet whose debounced PUT is still in flight on a slow link
    const text = "x".repeat(40_000);
    store.replace({ tasks: [{ ...serverTask, text }], archive: [] });
    await vi.advanceTimersByTimeAsync(300);
    expect(puts()).toHaveLength(1);

    // a newer edit, then the tab is hidden before its delay runs out
    store.toggleDone(firstTask(store));
    setVisibility("hidden");
    expect(puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status).toBe("saving");

    for (const release of held) release();
    await vi.waitFor(() => {
      expect(store.status).toBe("synced");
    });
    expect(accepted).toHaveLength(2);
    expect(JSON.parse(accepted[1] ?? "null")).toMatchObject({
      tasks: [{ id: "t1", done: true }],
    });
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
    { tasks: [serverTask, plumber], archive: [] },
    null,
    2,
  );

  /** A store loaded from its cache, saving to a server that takes every PUT. */
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
    store.finishEdit(draft, "  buy milk \n");

    expect(store.draft).toBeNull();
    expect(store.editingId).toBeNull();
    const added = { id: draft.id, text: "buy milk", x: 0.4, y: 0.6 };
    expect(store.sheet.tasks).toMatchObject([
      { id: "t1" },
      { id: "t2" },
      added,
    ]);
    expect(storage.get(CACHE_KEY)).toBe(store.exportText());

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toMatchObject([
      { tasks: [{ id: "t1" }, { id: "t2" }, added] },
    ]);
  });

  it("removes only the note whose text was emptied, and saves that", async () => {
    const store = await editingStore();
    const task = sheetTask(store, "t2");
    store.startEdit(task);
    store.finishEdit(task, " \n ");

    expect(store.editingId).toBeNull();
    expect(store.sheet.tasks).toEqual([serverTask]);

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toEqual([{ tasks: [serverTask], archive: [] }]);
  });

  it("updates an edited note in place with its text trimmed", async () => {
    const store = await editingStore();
    const task = sheetTask(store, "t2");
    store.startEdit(task);
    store.finishEdit(task, "\tcall the plumber today  ");

    expect(store.editingId).toBeNull();
    const edited = { ...plumber, text: "call the plumber today" };
    expect(store.sheet.tasks).toEqual([serverTask, edited]);

    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies()).toEqual([{ tasks: [serverTask, edited], archive: [] }]);
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
