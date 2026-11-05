// Test-only helpers shared by the component and drag tests.
import { flushSync } from "svelte";

/** The element `selector` matches; throws when nothing is rendered there. */
export function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

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
