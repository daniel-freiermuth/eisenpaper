// Test-only helpers shared by the component and drag tests.
import { flushSync } from "svelte";

/**
 * Dispatches a bubbling primary-button mouse pointer event at `target` and
 * flushes Svelte's pending updates. `init` overrides any field.
 */
export function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  init: PointerEventInit = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: x,
      clientY: y,
      bubbles: true,
      ...init,
    }),
  );
  flushSync();
}
