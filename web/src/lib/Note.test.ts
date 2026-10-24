// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import DetailPane from "./DetailPane.svelte";
import PriorityPane from "./PriorityPane.svelte";
import { store } from "./sheet.svelte";

// PriorityPane is the real host: it derives each note's `editing` prop from
// the store and renders the draft, so edits flow through the same paths as
// in the app.
let pane: Record<string, unknown>;
let commit: MockInstance<() => void>;

const PANE_W = 1000;
const PANE_H = 500;

function task() {
  const t = store.sheet.tasks[0];
  if (t === undefined) throw new Error("no task on the sheet");
  return t;
}

function note(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".note");
  if (el === null) throw new Error("no note rendered");
  return el;
}

const editor = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.note [role="textbox"]');

function openEditor(): HTMLElement {
  const el = editor();
  if (el === null) throw new Error("editor not open");
  return el;
}

function startEdit(): HTMLElement {
  store.startEdit(task());
  flushSync();
  return openEditor();
}

function type(el: HTMLElement, text: string): void {
  el.textContent = text;
}

function press(el: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(e);
  flushSync();
  return e;
}

function pointer(type: string, clientX: number, clientY: number): void {
  note().dispatchEvent(
    new PointerEvent(type, {
      button: 0,
      pointerId: 1,
      clientX,
      clientY,
      bubbles: true,
    }),
  );
  flushSync();
}

beforeEach(() => {
  store.cancelEdit();
  store.select(null);
  store.sheet = {
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
  };
  // persistence is SheetStore's concern (sheet.svelte.test.ts); here only
  // whether the note asks for it matters
  commit = vi.spyOn(store, "commit").mockImplementation(() => undefined);
  pane = mount(PriorityPane, { target: document.body });
  flushSync();
});

afterEach(() => {
  void unmount(pane);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Note in-place editor", () => {
  it("fills the editor with the task text, focuses it and puts the caret at the end", () => {
    const el = startEdit();

    expect(el.innerText).toBe("file tax return");
    expect(document.activeElement).toBe(el);
    const sel = getSelection();
    expect(sel?.isCollapsed).toBe(true);
    expect(sel?.anchorNode).toBe(el);
    expect(sel?.anchorOffset).toBe(el.childNodes.length);
  });

  it("saves the typed text on Enter without restarting the edit", () => {
    const el = startEdit();
    type(el, "  file taxes by friday  ");

    const e = press(el, "Enter");

    expect(e.defaultPrevented).toBe(true);
    expect(task().text).toBe("file taxes by friday");
    // the note's own Enter handler must not see the key and reopen the editor
    expect(store.editingId).toBeNull();
    expect(editor()).toBeNull();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("keeps the editor open on Shift+Enter and saves the line break", () => {
    const el = startEdit();

    const e = press(el, "Enter", true);

    expect(e.defaultPrevented).toBe(false); // the browser inserts the newline
    expect(store.editingId).toBe("t1");
    expect(editor()).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(commit).not.toHaveBeenCalled();

    // happy-dom's innerText drops the <br> a browser reports as "\n"
    Object.defineProperty(el, "innerText", {
      value: "file tax return\nand the vat form",
      configurable: true,
    });
    el.blur();
    flushSync();

    expect(task().text).toBe("file tax return\nand the vat form");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("discards the typed text of an existing note on Escape", () => {
    const el = startEdit();
    type(el, "half-typed");

    const e = press(el, "Escape");

    expect(e.defaultPrevented).toBe(true);
    expect(task().text).toBe("file tax return");
    expect(store.editingId).toBeNull();
    expect(editor()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("discards a new draft on Escape", () => {
    store.addDraft(0.3, 0.3);
    flushSync();
    const el = openEditor();
    type(el, "half-typed");

    press(el, "Escape");

    expect(store.draft).toBeNull();
    expect(store.sheet.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(editor()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("saves the next edit after an Escape cancelled the previous one", () => {
    press(startEdit(), "Escape");

    const el = startEdit();
    type(el, "file taxes by friday");
    el.blur(); // clicking elsewhere, not Enter
    flushSync();

    expect(task().text).toBe("file taxes by friday");
    expect(store.editingId).toBeNull();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("keeps the detail pane open when Escape discards an edit", () => {
    const detail = mount(DetailPane, {
      target: document.body,
      props: { onManageProjects: () => undefined },
    });
    try {
      store.select("t1");
      press(startEdit(), "Escape");

      expect(store.editingId).toBeNull();
      expect(store.selectedId).toBe("t1");

      // with no edit running, Escape is the pane's again
      press(document.body, "Escape");
      expect(store.selectedId).toBeNull();
    } finally {
      void unmount(detail);
    }
  });

  it("leaves the native text menu to a right-click in the editor", () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const el = startEdit();

    const e = new MouseEvent("contextmenu", {
      button: 2,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(e);
    flushSync();

    expect(e.defaultPrevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(store.sheet.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(store.editingId).toBe("t1");
    expect(editor()).toBe(el);
  });
});

describe("Note drag versus click", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // happy-dom has no layout: the note has no offsetParent, so a press
    // measures the document element instead of the pane
    Object.defineProperties(document.documentElement, {
      clientWidth: { value: PANE_W, configurable: true },
      clientHeight: { value: PANE_H, configurable: true },
    });
  });

  afterEach(() => {
    const root = document.documentElement as unknown as Record<string, unknown>;
    delete root["clientWidth"];
    delete root["clientHeight"];
  });

  it("treats movement under the threshold as a click that selects the note", () => {
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 103, 104); // 5px
    pointer("pointerup", 103, 104);

    vi.advanceTimersByTime(260); // the double-click window
    flushSync();
    expect(store.selectedId).toBe("t1");
    // selecting is view state: nothing moved, nothing crossed out or saved
    expect(task()).toMatchObject({ x: 0.5, y: 0.5, done: false });
    expect(commit).not.toHaveBeenCalled();
  });

  it("crosses out with ✓ without selecting or dragging the note", () => {
    const check = note().querySelector<HTMLButtonElement>("button.check");
    if (check === null) throw new Error("no ✓ button");
    check.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, bubbles: true }),
    );
    check.click();
    flushSync();

    expect(task()).toMatchObject({ x: 0.5, y: 0.5, done: true });
    expect(commit).toHaveBeenCalledOnce(); // by toggleDone
    expect(store.selectedId).toBeNull();
  });

  it("edits on a double-click without selecting, so the panes keep still under the second click", () => {
    // selecting opens the detail pane, which on wide screens narrows the
    // priority pane and slides every note left mid-gesture
    pointer("pointerdown", 100, 100);
    pointer("pointerup", 100, 100);
    expect(store.selectedId).toBeNull();
    pointer("pointerdown", 100, 100);
    pointer("pointerup", 100, 100);
    note().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    vi.runAllTimers();
    flushSync();

    expect(store.editingId).toBe("t1");
    expect(store.draft).toBeNull();
    expect(store.selectedId).toBeNull();
  });

  it("keeps the panes still under the second click of a double-click paced at the OS default", () => {
    // browsers fire dblclick for two clicks within the OS double-click time:
    // 400ms by default on GNOME, 500ms on Windows
    pointer("pointerdown", 100, 100);
    pointer("pointerup", 100, 100);
    vi.advanceTimersByTime(450);
    flushSync();
    expect(store.selectedId).toBeNull();
    pointer("pointerdown", 100, 100);
    pointer("pointerup", 100, 100);
    note().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    vi.runAllTimers();
    flushSync();

    expect(store.editingId).toBe("t1");
    expect(store.selectedId).toBeNull();
  });

  it("moves the note from the threshold on and commits once on release", () => {
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 106, 100); // exactly 6px
    expect(task().x).toBeCloseTo(0.5 + 6 / PANE_W);

    pointer("pointermove", 200, 150);
    expect(task().x).toBeCloseTo(0.6);
    expect(task().y).toBeCloseTo(0.6);
    expect(commit).not.toHaveBeenCalled(); // store.move does not persist

    pointer("pointerup", 200, 150);
    vi.runAllTimers();
    flushSync();

    expect(commit).toHaveBeenCalledOnce();
    expect(task()).toMatchObject({ done: false }); // a drag is not a click
    expect(store.selectedId).toBeNull();
  });
});
