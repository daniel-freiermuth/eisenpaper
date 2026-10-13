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
