// @vitest-environment happy-dom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { drag, draggable } from "./drag.svelte";

// happy-dom has no layout, so every rectangle and hit test below is stubbed.
// The zone holds four scraps 40px tall, 100px apart; "me" is the one being
// picked up, so the others' midpoints are a: 20, b: 220, c: 320.
const ZONE = "day:2026-10-20";
const CARD = { left: 100, top: 100, width: 80, height: 40 };

let zone: HTMLElement;
let me: HTMLElement;
let other: HTMLElement;
let outside: HTMLElement;
let navButton: HTMLElement;
/** what `document.elementFromPoint` reports under the pointer */
let under: Element | null;
let detach: (() => void)[];

interface Spies {
  onTap: Mock<() => void>;
  onDrop: Mock<(zone: string, index: number) => void>;
}

function setRect(
  el: HTMLElement,
  r: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
    new DOMRect(r.left, r.top, r.width, r.height),
  );
}

function scrap(id: string, top: number): HTMLElement {
  const el = document.createElement("div");
  el.dataset["id"] = id;
  setRect(el, { ...CARD, top });
  zone.append(el);
  return el;
}

function attach(el: HTMLElement, id: string): Spies {
  const spies: Spies = { onTap: vi.fn(), onDrop: vi.fn() };
  const cleanup = draggable({ id, text: `task ${id}`, done: false, ...spies })(
    el,
  );
  if (typeof cleanup !== "function") throw new Error("no cleanup returned");
  detach.push(cleanup);
  return spies;
}

/** A pointer event; move/up/cancel bubble from the element to the window. */
function fire(
  el: Element,
  type: string,
  clientX: number,
  clientY: number,
  init: PointerEventInit = {},
): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

const touch: PointerEventInit = { pointerType: "touch" };

function escape(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

/** Mouse: press on the card and drag past the threshold. */
function liftByMouse(x = 110, y = 120): void {
  fire(me, "pointerdown", x, y);
  fire(document.body, "pointermove", x + 6, y);
}

beforeEach(() => {
  vi.useFakeTimers();
  detach = [];
  zone = document.createElement("div");
  zone.dataset["zone"] = ZONE;
  document.body.append(zone);
  scrap("a", 0);
  me = scrap("me", 100);
  other = scrap("b", 200);
  scrap("c", 300);
  outside = document.createElement("div");
  navButton = document.createElement("button");
  navButton.dataset["nav"] = "next";
  document.body.append(outside, navButton);
  under = outside;
  vi.spyOn(document, "elementFromPoint").mockImplementation(() => under);
});

afterEach(() => {
  escape(); // ends any press a test left pending, so no listener leaks
  for (const cleanup of detach) cleanup();
  drag.current = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("draggable with a mouse", () => {
  it("treats a press that moves less than 6px as a tap", () => {
    const { onTap, onDrop } = attach(me, "me");

    fire(me, "pointerdown", 110, 120);
    fire(document.body, "pointermove", 113, 124); // 5px
    expect(drag.current).toBeNull();
    fire(document.body, "pointerup", 113, 124);

    expect(onTap).toHaveBeenCalledOnce();
    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.current).toBeNull();
  });

  it("lifts at the press point from 6px on, keeping the grab offset", () => {
    const { onTap } = attach(me, "me");

    fire(me, "pointerdown", 110, 120);
    fire(document.body, "pointermove", 116, 120); // exactly 6px

    expect(drag.current).toMatchObject({
      id: "me",
      text: "task me",
      done: false,
      x: 110,
      y: 120,
      grabX: 10, // relative to the card's top-left (100, 100)
      grabY: 20,
      width: 80,
    });

    fire(document.body, "pointermove", 300, 400);
    expect(drag.current).toMatchObject({ x: 300, y: 400, grabX: 10 });

    fire(document.body, "pointerup", 300, 400);
    expect(onTap).not.toHaveBeenCalled(); // a drag is not a tap
  });

  it("ignores a press with any button but the primary one", () => {
    const { onTap, onDrop } = attach(me, "me");

    fire(me, "pointerdown", 110, 120, { button: 2 });
    fire(document.body, "pointermove", 200, 200);
    fire(document.body, "pointerup", 200, 200);

    expect(drag.current).toBeNull();
    expect(onTap).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("ignores a press on another scrap while one is lifted", () => {
    const mine = attach(me, "me");
    const theirs = attach(other, "b");
    liftByMouse();

    under = zone;
    fire(other, "pointerdown", 110, 330);
    fire(document.body, "pointermove", 110, 330);
    fire(document.body, "pointerup", 110, 330);

    expect(theirs.onTap).not.toHaveBeenCalled();
    expect(theirs.onDrop).not.toHaveBeenCalled();
    expect(mine.onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 3);
  });
});

describe("draggable drop", () => {
  it("drops into the zone under the pointer, hit-testing on release", () => {
    const { onTap, onDrop } = attach(me, "me");
    liftByMouse();
    under = zone;

    // no animation frame runs between this move and the release, so the
    // index can only come from the hit test the release itself does
    fire(document.body, "pointermove", 110, 219);
    fire(document.body, "pointerup", 110, 219);

    expect(onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 1);
    expect(onTap).not.toHaveBeenCalled();
    expect(drag.current).toBeNull();
  });

  it("does nothing when released outside every zone", () => {
    const { onTap, onDrop } = attach(me, "me");
    liftByMouse();

    fire(document.body, "pointerup", 500, 500);

    expect(onDrop).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
    expect(drag.current).toBeNull();
  });

  it.each([
    [0, 0, "above the first scrap"],
    [150, 1, "over itself, which does not count"],
    [219, 1, "just above b's midpoint"],
    [220, 2, "on b's midpoint"],
    [319, 2, "just above c's midpoint"],
    [320, 3, "below every other scrap"],
  ])("puts a scrap released at y=%i at index %i (%s)", (y, index) => {
    const { onDrop } = attach(me, "me");
    liftByMouse();
    under = zone;

    fire(document.body, "pointermove", 110, y);
    vi.advanceTimersToNextFrame();
    expect(drag.current).toMatchObject({ zone: ZONE, index });

    fire(document.body, "pointerup", 110, y);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, index);
  });

  it("reports the hover-to-page button under the pointer", () => {
    attach(me, "me");
    liftByMouse();

    under = navButton;
    vi.advanceTimersToNextFrame();
    expect(drag.current).toMatchObject({ nav: "next", zone: null });

    under = zone;
    vi.advanceTimersToNextFrame();
    expect(drag.current).toMatchObject({ nav: null, zone: ZONE });
  });
});

describe("draggable cancel", () => {
  it.each([
    ["Escape", escape],
    [
      "pointercancel",
      () => {
        fire(document.body, "pointercancel", 110, 219);
      },
    ],
  ])(
    "%s ends the drag and the release that follows does nothing",
    (_, cancel) => {
      const { onTap, onDrop } = attach(me, "me");
      liftByMouse();
      under = zone;

      cancel();
      expect(drag.current).toBeNull();

      // the window listeners are gone: no re-lift, no tap, no drop
      fire(document.body, "pointermove", 300, 219);
      fire(document.body, "pointerup", 300, 219);
      expect(drag.current).toBeNull();
      expect(onTap).not.toHaveBeenCalled();
      expect(onDrop).not.toHaveBeenCalled();
    },
  );

  it("ignores keys other than Escape", () => {
    attach(me, "me");
    liftByMouse();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(drag.current).not.toBeNull();
  });
});

describe("draggable with touch", () => {
  it("treats a release before the 280ms long press as a tap", () => {
    const { onTap, onDrop } = attach(me, "me");

    fire(me, "pointerdown", 110, 120, touch);
    vi.advanceTimersByTime(279);
    fire(document.body, "pointerup", 110, 120, touch);
    vi.advanceTimersByTime(100); // the cleared timer must not lift later

    expect(onTap).toHaveBeenCalledOnce();
    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.current).toBeNull();
  });

  it("does not lift a mouse-style 6px move before the long press", () => {
    attach(me, "me");

    fire(me, "pointerdown", 110, 120, touch);
    fire(document.body, "pointermove", 117, 120, touch);

    expect(drag.current).toBeNull();
  });

  it("treats moving more than 10px first as a scroll, not a tap", () => {
    const { onTap, onDrop } = attach(me, "me");

    fire(me, "pointerdown", 110, 120, touch);
    fire(document.body, "pointermove", 110, 131, touch); // 11px
    vi.advanceTimersByTime(300);
    expect(drag.current).toBeNull();

    fire(document.body, "pointerup", 110, 131, touch);
    expect(onTap).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("lifts after 280ms despite a 10px wobble and drops where released", () => {
    const { onTap, onDrop } = attach(me, "me");

    fire(me, "pointerdown", 110, 120, touch);
    fire(document.body, "pointermove", 110, 130, touch); // exactly 10px
    vi.advanceTimersByTime(279);
    expect(drag.current).toBeNull();
    vi.advanceTimersByTime(1);
    // lifted where the finger went down, not where it wobbled to
    expect(drag.current).toMatchObject({ id: "me", x: 110, y: 120, grabY: 20 });

    under = zone;
    fire(document.body, "pointermove", 110, 250, touch);
    fire(document.body, "pointerup", 110, 250, touch);

    expect(onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 2);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("lifts only the first of two scraps long-pressed at once", () => {
    const mine = attach(me, "me");
    const theirs = attach(other, "b");
    const finger1: PointerEventInit = { ...touch, pointerId: 1 };
    const finger2: PointerEventInit = { ...touch, pointerId: 2 };

    fire(me, "pointerdown", 110, 120, finger1);
    fire(other, "pointerdown", 110, 220, finger2);
    vi.advanceTimersByTime(300); // both fingers held past the long press
    expect(drag.current).toMatchObject({ id: "me", x: 110, y: 120 });

    under = zone;
    fire(document.body, "pointermove", 110, 330, finger1);
    expect(drag.current).toMatchObject({ id: "me", x: 110, y: 330 });
    fire(document.body, "pointerup", 110, 330, finger1);
    fire(document.body, "pointerup", 110, 220, finger2);

    expect(mine.onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 3);
    expect(theirs.onTap).not.toHaveBeenCalled();
    expect(theirs.onDrop).not.toHaveBeenCalled();
  });

  it("lets a second finger on a still-pending scrap take over its press", () => {
    const { onTap, onDrop } = attach(me, "me");
    const finger1: PointerEventInit = { ...touch, pointerId: 1 };
    const finger2: PointerEventInit = { ...touch, pointerId: 2 };

    fire(me, "pointerdown", 110, 120, finger1);
    vi.advanceTimersByTime(200);
    fire(me, "pointerdown", 150, 130, finger2);
    vi.advanceTimersByTime(100); // finger 1's long press would end here
    expect(drag.current).toBeNull();

    vi.advanceTimersByTime(180); // finger 2 has now held for 280ms
    expect(drag.current).toMatchObject({ id: "me", x: 150, y: 130 });
    fire(document.body, "pointermove", 150, 330, finger2);
    vi.advanceTimersByTime(300);
    expect(drag.current).toMatchObject({ id: "me", x: 150, y: 330 });

    under = zone;
    fire(document.body, "pointerup", 110, 120, finger1); // no longer ours
    expect(drag.current).toMatchObject({ id: "me" });
    fire(document.body, "pointerup", 150, 330, finger2);

    expect(onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 3);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("vetoes page scrolling only while a scrap is lifted", () => {
    attach(me, "me");
    const scroll = (): boolean => {
      const e = new Event("touchmove", { bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };

    expect(scroll()).toBe(false);
    fire(me, "pointerdown", 110, 120, touch);
    expect(scroll()).toBe(false); // still waiting for the long press
    vi.advanceTimersByTime(280);
    expect(scroll()).toBe(true);
    escape();
    expect(scroll()).toBe(false);
  });

  it("swallows the context menu a long press would open", () => {
    attach(me, "me");
    const e = new Event("contextmenu", { bubbles: true, cancelable: true });

    me.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
  });
});

describe("draggable lifecycle", () => {
  it("carries the drag to its drop when its lifted scrap is detached", () => {
    const { onDrop } = attach(me, "me");
    liftByMouse();
    under = zone;

    // hover-paging unmounts the day the scrap was lifted from
    const cleanup = detach.pop();
    cleanup?.();
    expect(drag.current).toMatchObject({ id: "me" });

    fire(document.body, "pointerup", 110, 219);
    expect(drag.current).toBeNull();
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 1);
  });

  it("leaves another scrap's drag alone when an idle one is detached", () => {
    attach(me, "me");
    attach(other, "b");
    liftByMouse();

    const cleanup = detach.pop(); // b's
    cleanup?.();

    expect(drag.current).toMatchObject({ id: "me" });
  });

  it("still vetoes scrolling when its lifted scrap is detached mid-touch", () => {
    attach(me, "me");
    fire(me, "pointerdown", 110, 120, touch);
    vi.advanceTimersByTime(280);

    // hover-paging unmounts the day; the finger's touchmoves keep targeting
    // the detached card, whose event path no longer reaches document
    detach.pop()?.();
    me.remove();
    const e = new Event("touchmove", { bubbles: true, cancelable: true });
    me.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
  });

  it("stops listening for presses once detached", () => {
    const { onTap } = attach(me, "me");
    detach.pop()?.();

    fire(me, "pointerdown", 110, 120);
    fire(document.body, "pointerup", 110, 120);

    expect(onTap).not.toHaveBeenCalled();
  });

  it.each([
    [
      "mouse",
      {},
      () => {
        fire(document.body, "pointermove", 116, 120); // past the threshold
      },
    ],
    [
      "touch",
      touch,
      () => {
        vi.advanceTimersByTime(280); // the long press
      },
    ],
  ])(
    "drops a pending %s press when its scrap leaves the page",
    (_, init, wouldLift) => {
      const { onTap, onDrop } = attach(me, "me");
      fire(me, "pointerdown", 110, 120, init);

      // a synced delete or move unmounts the scrap before it lifted
      me.remove();
      detach.pop()?.();
      wouldLift();
      expect(drag.current).toBeNull();

      under = zone;
      fire(document.body, "pointerup", 110, 219, init);
      expect(onTap).not.toHaveBeenCalled();
      expect(onDrop).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "released while the other is up",
      () => {
        expect(drag.current).toMatchObject({ id: "me" });
      },
    ],
    [
      "outliving the other's drop",
      () => {
        fire(document.body, "pointerup", 110, 120, touch); // the first drops
        vi.advanceTimersByTime(180); // the second's long press comes due
        expect(drag.current).toBeNull();
      },
    ],
  ])(
    "drops a pending press whose scrap leaves the page while another scrap is lifted, %s",
    (_, then) => {
      attach(me, "me");
      const theirs = attach(other, "b");
      fire(me, "pointerdown", 110, 120, touch);
      vi.advanceTimersByTime(180);
      // a second finger presses before the first's long press lifts
      fire(other, "pointerdown", 110, 220, { ...touch, pointerId: 2 });
      vi.advanceTimersByTime(100);
      expect(drag.current).toMatchObject({ id: "me" });

      // a sync deletes the second scrap while its press is still pending
      other.remove();
      detach.pop()?.();
      then();

      under = zone;
      fire(document.body, "pointerup", 110, 319, { ...touch, pointerId: 2 });
      expect(theirs.onTap).not.toHaveBeenCalled();
      expect(theirs.onDrop).not.toHaveBeenCalled();
    },
  );

  it("keeps a pending press when its attachment re-runs on the same scrap", () => {
    const { onDrop } = attach(me, "me");
    fire(me, "pointerdown", 110, 120, touch);

    // a synced edit re-runs the attachment; the scrap stays on the page
    detach.pop()?.();
    attach(me, "me");
    vi.advanceTimersByTime(280);
    expect(drag.current).toMatchObject({ id: "me" });

    under = zone;
    fire(document.body, "pointerup", 110, 219, touch);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(ZONE, 1);
  });
});
