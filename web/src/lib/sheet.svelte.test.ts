import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { Sheet } from "./model";

const serverSheet: Sheet = {
  tasks: [
    {
      id: "t1",
      text: "file tax return",
      x: 0.5,
      y: 0.5,
      done: false,
      created: 1,
    },
  ],
  archive: [],
  savedAt: 10,
};
const serverText = JSON.stringify(serverSheet, null, 2);

const reply = (status: number, body = ""): Response =>
  new Response(status === 204 ? null : body, {
    status,
    headers: { "x-eisenpaper": "1" },
  });

/** GET serves `serverText`; PUT answers with `putStatus`. */
const server =
  (putStatus: number) =>
  (_url: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      init?.method === "PUT" ? reply(putStatus) : reply(200, serverText),
    );

let fetchMock: Mock<typeof fetch>;

const putBodies = (): unknown[] =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);

async function loadStore() {
  // the store is a module singleton that reads localStorage on load, so each
  // test needs a fresh module evaluated after the globals are stubbed
  vi.resetModules();
  return (await import("./sheet.svelte")).store;
}

beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
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
    store.replace({ tasks: [], archive: [] }); // local edit, newer than the server
    fetchMock.mockImplementation(server(500));
    await store.sync();
    expect(store.status).toBe("error");

    fetchMock.mockReset();
    fetchMock.mockImplementation(server(204));
    await store.sync();

    expect(putBodies()).toMatchObject([{ tasks: [] }]);
    expect(store.status).toBe("synced");
  });
});
