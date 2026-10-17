import { dayKey } from "./schedule";

/** The current local date, kept fresh across midnight and sleeping tabs. */
class Today {
  value = $state(dayKey(new Date()));

  /** Starts ticking; returns the teardown. */
  start(): () => void {
    const tick = (): void => {
      this.value = dayKey(new Date());
    };
    const timer = setInterval(tick, 60_000);
    addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", tick);
    };
  }
}

export const today = new Today();
