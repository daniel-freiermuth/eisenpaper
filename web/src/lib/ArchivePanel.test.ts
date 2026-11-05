// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it } from "vitest";

import ArchivePanel from "./ArchivePanel.svelte";
import { store } from "./sheet.svelte";

let panel: Record<string, unknown> | undefined;

afterEach(() => {
  if (panel !== undefined) void unmount(panel);
  panel = undefined;
  document.body.innerHTML = "";
});

it("lists old sheets newest first even when a merge left them out of order", () => {
  // mergeSheets puts remote entries before local ones, whatever their dates.
  store.sheet = {
    tasks: [],
    archive: [
      { at: 2000, tasks: [] },
      { at: 1000, tasks: [] },
      { at: 3000, tasks: [] },
    ],
  };
  panel = mount(ArchivePanel, { target: document.body, props: { open: true } });
  flushSync();
  const dates = [...document.querySelectorAll(".date")].map(
    (d) => d.textContent,
  );
  expect(dates).toEqual(
    [3000, 2000, 1000].map((at) => new Date(at).toLocaleString()),
  );
});
