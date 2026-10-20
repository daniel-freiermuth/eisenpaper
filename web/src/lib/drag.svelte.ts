import type { Attachment } from "svelte/attachments";

/** below this a mouse press counts as a click, not a drag */
const DRAG_THRESHOLD_PX = 6;
/** touch: hold this long to pick a scrap up; moving earlier scrolls instead */
const LONG_PRESS_MS = 280;
/** touch: finger wobble tolerated while waiting for the long press */
const TOUCH_SLOP_PX = 10;
/** pointer this close to a scroll area's edge scrolls it */
const EDGE_PX = 48;
const EDGE_SPEED_PX = 12;
/** the pointer must rest in the edge band this long before scrolling starts */
const EDGE_DWELL_MS = 350;

/** A scrap in flight. Zones and items are found through `data-zone` / `data-id`. */
export interface Lifted {
  id: string;
  text: string;
  done: boolean;
  /** pointer position */
  x: number;
  y: number;
  /** where the card was grabbed, relative to its top-left corner */
  grabX: number;
  grabY: number;
  width: number;
  /** `data-zone` under the pointer, null = not droppable here */
  zone: string | null;
  /** insertion index among the zone's other scraps */
  index: number;
  /** `data-nav` under the pointer, for hover-to-page buttons */
  nav: string | null;
}

class DragState {
  current = $state<Lifted | null>(null);
}

export const drag = new DragState();

// Once a scrap is lifted, a touch drag must not also scroll the page. Only a
// non-passive document listener can veto that once the gesture is underway.
document.addEventListener(
  "touchmove",
  (e) => {
    if (drag.current !== null) e.preventDefault();
  },
  { passive: false },
);

/** Updates zone, index and nav under the pointer. */
function hitTest(d: Lifted): void {
  const under = document.elementFromPoint(d.x, d.y);
  d.nav = under?.closest<HTMLElement>("[data-nav]")?.dataset["nav"] ?? null;
  const zoneEl = under?.closest<HTMLElement>("[data-zone]");
  d.zone = zoneEl?.dataset["zone"] ?? null;
  if (zoneEl === undefined || zoneEl === null) return;
  const others = [...zoneEl.querySelectorAll<HTMLElement>("[data-id]")].filter(
    (el) => el.dataset["id"] !== d.id,
  );
  const i = others.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return d.y < r.top + r.height / 2;
  });
  d.index = i === -1 ? others.length : i;
}

/** the edge band the pointer rests in, and since when */
let edge: { area: HTMLElement; dir: number; since: number } | null = null;

/**
 * Scrolls whatever `data-autoscroll` area the pointer lingers at the edge
 * of. Merely crossing an edge (tray → days on a phone) must not scroll.
 */
function autoScroll(d: Lifted): void {
  let area = document
    .elementFromPoint(d.x, d.y)
    ?.closest<HTMLElement>("[data-autoscroll]");
  // an area with nothing to scroll in this layout (a day's list in the
  // stacked schedule) leaves the edge to the area around it
  while (
    area !== undefined &&
    area !== null &&
    area.scrollHeight <= area.clientHeight
  )
    area = area.parentElement?.closest<HTMLElement>("[data-autoscroll]");
  const r = area?.getBoundingClientRect();
  const dir =
    r === undefined
      ? 0
      : d.y < r.top + EDGE_PX
        ? -1
        : d.y > r.bottom - EDGE_PX
          ? 1
          : 0;
  if (area === undefined || area === null || dir === 0) {
    edge = null;
    return;
  }
  if (edge?.area !== area || edge.dir !== dir)
    edge = { area, dir, since: performance.now() };
  if (performance.now() - edge.since >= EDGE_DWELL_MS)
    area.scrollTop += dir * EDGE_SPEED_PX;
}

export interface DraggableOptions {
  id: string;
  text: string;
  done: boolean;
  /** a press that never became a drag */
  onTap: () => void;
  /** released over `zone` at `index` */
  onDrop: (zone: string, index: number) => void;
}

/** Makes a scrap pickable: mouse drags past a threshold, touch after a long press. */
export function draggable(opts: DraggableOptions): Attachment<HTMLElement> {
  return (el) => {
    let press: {
      /** the pointer that pressed; other fingers' events are not ours */
      pointerId: number;
      x: number;
      y: number;
      touch: boolean;
      timer: number | undefined;
    } | null = null;
    let frame = 0;

    const lift = (x: number, y: number): void => {
      const r = el.getBoundingClientRect();
      drag.current = {
        id: opts.id,
        text: opts.text,
        done: opts.done,
        x,
        y,
        grabX: x - r.left,
        grabY: y - r.top,
        width: r.width,
        zone: null,
        index: 0,
        nav: null,
      };
      if ("vibrate" in navigator) navigator.vibrate(10);
      const loop = (): void => {
        const d = drag.current;
        if (d === null) return;
        autoScroll(d);
        hitTest(d);
        frame = requestAnimationFrame(loop);
      };
      loop();
    };

    const end = (): void => {
      if (press !== null) clearTimeout(press.timer);
      press = null;
      cancelAnimationFrame(frame);
      drag.current = null;
      edge = null;
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onCancel);
      removeEventListener("keydown", onKey);
    };

    const onMove = (e: PointerEvent): void => {
      if (press?.pointerId !== e.pointerId) return;
      const d = drag.current;
      if (d !== null) {
        d.x = e.clientX;
        d.y = e.clientY;
        return;
      }
      const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (press.touch) {
        if (dist > TOUCH_SLOP_PX) end(); // a scroll, not a pick-up
        return;
      }
      if (dist >= DRAG_THRESHOLD_PX) lift(press.x, press.y);
    };

    const onUp = (e: PointerEvent): void => {
      if (press?.pointerId !== e.pointerId) return;
      const d = drag.current;
      if (d === null) {
        end();
        opts.onTap();
        return;
      }
      hitTest(d);
      const { zone, index } = d;
      end();
      if (zone !== null) opts.onDrop(zone, index);
    };

    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === press?.pointerId) end();
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") end();
    };

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || drag.current !== null) return;
      const touch = e.pointerType === "touch";
      press = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        touch,
        timer: touch
          ? window.setTimeout(() => {
              if (press !== null) lift(press.x, press.y);
            }, LONG_PRESS_MS)
          : undefined,
      };
      addEventListener("pointermove", onMove);
      addEventListener("pointerup", onUp);
      addEventListener("pointercancel", onCancel);
      addEventListener("keydown", onKey);
    };

    // a long press would otherwise open the context menu on Android
    const onContext = (e: Event): void => {
      e.preventDefault();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("contextmenu", onContext);
    return () => {
      if (drag.current?.id === opts.id) end();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("contextmenu", onContext);
    };
  };
}
