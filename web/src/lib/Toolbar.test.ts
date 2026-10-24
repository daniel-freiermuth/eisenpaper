// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";

import type { Sheet, Task } from "./model";
import { store } from "./sheet.svelte";
import Toolbar from "./Toolbar.svelte";

let toolbar: Record<string, unknown>;
let commit: MockInstance<() => void>;
let alert: Mock<(message?: unknown) => void>;
let confirm: Mock<(message?: string) => boolean>;

const scrap = (id: string, done: boolean): Task => ({
  id,
  text: `task ${id}`,
  x: 0.5,
  y: 0.5,
  done,
  created: 1,
});

/** A fresh copy each call, so the store never shares objects with `expect`. */
const current = (): Sheet => ({
  tasks: [scrap("keep1", false), scrap("done1", true)],
  archive: [],
});

const imported: Sheet = {
  tasks: [scrap("in1", false), scrap("in2", true)],
  archive: [{ at: 5, tasks: [scrap("old1", true)] }],
};

function button(label: string): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent.trim() === label,
  );
  if (el === undefined) throw new Error(`no "${label}" button`);
  return el;
}

function fileInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (el === null) throw new Error("no file input");
  return el;
}

/** What the browser does when the user picks `text` in the file dialog. */
function choose(text: string, name = "sheet.json"): HTMLInputElement {
  const input = fileInput();
  const picked = new DataTransfer();
  picked.items.add(new File([text], name, { type: "application/json" }));
  input.files = picked.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}

beforeEach(() => {
  store.cancelEdit();
  store.sheet = current();
  // persistence is SheetStore's concern (sheet.svelte.test.ts); here only
  // whether the toolbar lets a whole-sheet change through matters
  commit = vi.spyOn(store, "commit").mockImplementation(() => undefined);
  // happy-dom has no dialogs; these stand in for the user's answer
  alert = vi.fn();
  confirm = vi.fn(() => true);
  vi.stubGlobal("alert", alert);
  vi.stubGlobal("confirm", confirm);
  toolbar = mount(Toolbar, {
    target: document.body,
    props: { onOpenArchive: () => undefined, onOpenSettings: () => undefined },
  });
  flushSync();
});

afterEach(() => {
  void unmount(toolbar);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Toolbar import", () => {
  it("does nothing when the dialog closes without a file", () => {
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));

    expect(alert).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(store.sheet).toEqual(current());
  });

  it.each([
    ["invalid JSON", "{ not json"],
    ["JSON that is not a sheet", JSON.stringify({ tasks: "nope" })],
    [
      "a sheet with a malformed task",
      JSON.stringify({ tasks: [{ id: "x" }], archive: [] }),
    ],
  ])("rejects %s with an alert and keeps the sheet", async (_, text) => {
    const input = choose(text);

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith(
        "import failed: not an eisenpaper sheet",
      );
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(store.sheet).toEqual(current());
    // a corrected file under the same name must fire `change` again
    expect(input.value).toBe("");
  });

  it("alerts when the picked file cannot be read and keeps the sheet", async () => {
    // what File.text() does when the file was moved, deleted or changed
    // between picking it and reading it
    vi.spyOn(File.prototype, "text").mockRejectedValue(
      new DOMException("the file could not be read", "NotReadableError"),
    );

    const input = choose(JSON.stringify(imported));

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith(
        "import failed: the file could not be read",
      );
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(store.sheet).toEqual(current());
    expect(input.value).toBe("");
  });

  it("reports the imported counts and replaces the sheet once confirmed", async () => {
    choose(JSON.stringify(imported));

    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledOnce();
    });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      "import 2 task(s) and 1 old sheet(s)? this replaces the current sheet.",
    );
    expect(alert).not.toHaveBeenCalled();
    expect(store.sheet).toEqual(imported);
  });

  it("keeps the current sheet when the confirm is declined", async () => {
    confirm.mockReturnValue(false);

    choose(JSON.stringify(imported));

    await vi.waitFor(() => {
      expect(confirm).toHaveBeenCalledOnce();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(store.sheet).toEqual(current());
  });

  it("clears the file input before asking, so the same file can be picked again", async () => {
    let valueAtConfirm: string | undefined;
    confirm.mockImplementation(() => {
      valueAtConfirm = fileInput().value;
      return true;
    });

    const input = choose(JSON.stringify(imported));
    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledOnce();
    });

    expect(valueAtConfirm).toBe("");
    expect(input.files?.length).toBe(0);

    // a local edit after the import, then the same file once more
    store.sheet = current();
    choose(JSON.stringify(imported));
    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledTimes(2);
    });
    expect(store.sheet).toEqual(imported);
  });
});

describe("Toolbar fresh sheet", () => {
  it("refuses with an alert when nothing is crossed out", () => {
    store.sheet = {
      tasks: [scrap("a", false), scrap("b", false)],
      archive: [],
    };

    button("fresh sheet").click();

    expect(alert).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(store.sheet.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(store.sheet.archive).toEqual([]);
  });

  it("reports how many tasks go and stay, then archives the crossed-out ones", () => {
    store.sheet = {
      tasks: [
        scrap("d1", true),
        scrap("o1", false),
        scrap("d2", true),
        scrap("o2", false),
        scrap("o3", false),
      ],
      archive: [],
    };

    button("fresh sheet").click();

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      "start a fresh sheet? 2 crossed-out task(s) go to the old sheets, 3 stay.",
    );
    expect(alert).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(store.sheet.tasks.map((t) => t.id)).toEqual(["o1", "o2", "o3"]);
    expect(store.sheet.archive).toHaveLength(1);
    expect(store.sheet.archive[0]?.tasks.map((t) => t.id)).toEqual([
      "d1",
      "d2",
    ]);
  });

  it("leaves tasks and archive untouched when the confirm is declined", () => {
    confirm.mockReturnValue(false);

    button("fresh sheet").click();

    expect(confirm).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(store.sheet).toEqual(current());
  });
});

describe("Toolbar export", () => {
  // East of UTC, just after local midnight the UTC date is still yesterday.
  const tz = process.env["TZ"];
  beforeEach(() => {
    process.env["TZ"] = "Europe/Berlin";
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (tz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = tz;
  });

  it("names the backup after the local calendar date", () => {
    vi.setSystemTime(new Date(2026, 9, 23, 1, 30));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sheet");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let download: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        download = this.download;
      },
    );

    button("export").click();

    expect(download).toBe("eisenpaper-2026-10-23.json");
  });
});
