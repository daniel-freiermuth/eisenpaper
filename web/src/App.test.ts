// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App.svelte";

let app: Record<string, unknown> | undefined;

function tab(label: string): HTMLButtonElement {
  const el = Array.from(
    document.querySelectorAll<HTMLButtonElement>("nav.tabs button"),
  ).find((b) => b.textContent.trim() === label);
  if (el === undefined) throw new Error(`no "${label}" tab`);
  return el;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
});

afterEach(() => {
  if (app !== undefined) void unmount(app);
  app = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App without a usable localStorage", () => {
  it("still mounts on the priority pane when the browser blocks storage", () => {
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Access is denied", "SecurityError");
      },
    });

    app = mount(App, { target: document.body });
    flushSync();

    expect(tab("priorities").getAttribute("aria-current")).toBe("page");
  });

  it("still switches panes when the preference cannot be saved", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
      removeItem: () => undefined,
    });

    app = mount(App, { target: document.body });
    flushSync();
    tab("schedule").click();
    flushSync();

    expect(tab("schedule").getAttribute("aria-current")).toBe("page");
  });
});
