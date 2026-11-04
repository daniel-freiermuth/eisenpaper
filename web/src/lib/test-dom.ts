// DOM lookups shared by the component tests; each throws instead of
// returning null so a missing element fails the test at the lookup.

/** The first element matching `selector`. */
export function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

/** The first button under `scope` whose trimmed text is `label`. */
export function buttonLabelled(
  label: string,
  scope = "button",
): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>(scope),
  ).find((b) => b.textContent.trim() === label);
  if (found === undefined) throw new Error(`no "${label}" in ${scope}`);
  return found;
}
