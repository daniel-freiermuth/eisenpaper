<script lang="ts">
  import {
    DEFAULT_TINT_ALPHA,
    PROJECT_COLORS,
    splitAlpha,
    tintColor,
    withAlpha,
  } from "./model";
  import { store } from "./sheet.svelte";
  import { tintStyle } from "./tint";

  interface Props {
    open?: boolean;
  }
  let { open = $bindable(false) }: Props = $props();

  let newName = $state("");

  const projects = $derived(store.sheet.projects ?? []);
  /** open-sheet tasks per project id */
  const counts = $derived(
    Object.groupBy(store.sheet.tasks, (t) => t.project ?? ""),
  );
  const count = (id: string): number => counts[id]?.length ?? 0;

  const PALETTE: readonly string[] = PROJECT_COLORS;
  /** a colour picked outside the palette, shown on the custom swatch */
  const customColor = (color: string | undefined): string | undefined =>
    color !== undefined && !PALETTE.includes(color) ? color : undefined;

  /**
   * The custom colour as picker hue plus tint opacity. Opaque or missing
   * colours read at the palette's strength, so a fresh pick looks familiar.
   */
  const customParts = (custom: string | undefined) =>
    (custom === undefined ? null : splitAlpha(tintColor(custom))) ?? {
      rgb: "#888888",
      alpha: DEFAULT_TINT_ALPHA,
    };

  function onadd(e: SubmitEvent): void {
    e.preventDefault();
    if (newName.trim() === "") return;
    if (store.addProject(newName) === null) {
      alert(`there already is a project called "${newName.trim()}".`);
      return;
    }
    newName = "";
  }

  function rename(
    id: string,
    e: Event & { currentTarget: HTMLInputElement },
  ): void {
    const input = e.currentTarget;
    if (store.renameProject(id, input.value)) return;
    const name = input.value.trim();
    if (name !== "") alert(`there already is a project called "${name}".`);
    // show the name that was kept
    input.value = projects.find((p) => p.id === id)?.name ?? "";
  }

  function remove(id: string, name: string): void {
    const n = count(id);
    const tasks =
      n === 0 ? "" : ` its ${String(n)} task(s) keep going without a project.`;
    if (confirm(`delete project "${name}"?${tasks}`)) store.removeProject(id);
  }

  /** spells out what the × does, since the tasks survive it */
  function deleteLabel(id: string, name: string): string {
    const n = count(id);
    return n === 0
      ? `delete project "${name}" (no tasks use it)`
      : `unassign ${String(n)} task(s) and delete project "${name}"`;
  }
</script>

<aside class:open aria-hidden={!open} inert={!open} aria-label="settings">
  <button class="close" onclick={() => (open = false)}>close</button>
  <h2>settings</h2>

  <section>
    <h3>projects</h3>
    {#each projects as project (project.id)}
      {@const custom = customColor(project.color)}
      {@const parts = customParts(custom)}
      <div class="entry">
        <div class="project">
          <input
            aria-label="project name"
            value={project.name}
            class:tinted={project.color !== undefined}
            style={tintStyle(project.color)}
            onchange={(e) => {
              rename(project.id, e);
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <span class="count" title="tasks on the sheet"
            >{count(project.id)}</span
          >
          <button
            class="delete"
            aria-label={deleteLabel(project.id, project.name)}
            title={deleteLabel(project.id, project.name)}
            onclick={() => {
              remove(project.id, project.name);
            }}>&times;</button
          >
        </div>
        <div
          class="swatches"
          role="radiogroup"
          aria-label="colour of {project.name}"
        >
          <button
            class="swatch none"
            role="radio"
            aria-checked={project.color === undefined}
            aria-label="no colour"
            title="no colour"
            onclick={() => {
              store.setProjectColor(project.id, null);
            }}
          ></button>
          {#each PROJECT_COLORS as color (color)}
            <button
              class="swatch"
              role="radio"
              aria-checked={project.color === color}
              aria-label={color}
              style:--swatch={color}
              onclick={() => {
                store.setProjectColor(project.id, color);
              }}
            ></button>
          {/each}
          <label
            class="swatch custom"
            class:picked={custom !== undefined}
            style:--swatch={custom === undefined ? undefined : parts.rgb}
            title="pick any colour"
          >
            <input
              type="color"
              aria-label="any colour"
              value={parts.rgb}
              oninput={(e) => {
                store.setProjectColor(
                  project.id,
                  withAlpha(e.currentTarget.value, parts.alpha),
                );
              }}
            />
          </label>
        </div>
        {#if custom !== undefined}
          <label class="opacity">
            opacity
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(parts.alpha * 100)}
              oninput={(e) => {
                store.setProjectColor(
                  project.id,
                  withAlpha(parts.rgb, Number(e.currentTarget.value) / 100),
                );
              }}
            />
            <span>{Math.round(parts.alpha * 100)}%</span>
          </label>
        {/if}
      </div>
    {:else}
      <p>no projects yet.</p>
    {/each}

    <form class="project" onsubmit={onadd}>
      <input
        aria-label="new project name"
        placeholder="new project…"
        bind:value={newName}
      />
      <button type="submit" disabled={newName.trim() === ""}>add</button>
    </form>
  </section>
</aside>

<style>
  aside {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 90vw);
    background: #efe9d8;
    border-left: 2px solid var(--faint);
    box-shadow: -4px 0 18px rgb(43 42 38 / 15%);
    transform: translateX(105%);
    transition: transform 0.2s ease;
    z-index: 30;
    padding: 18px;
    overflow-y: auto;
  }

  .open {
    transform: none;
  }

  h2 {
    margin: 0 0 4px;
    font-size: 22px;
  }

  h3 {
    margin: 0 0 8px;
    font-size: 18px;
  }

  section {
    margin: 14px 0;
    border-top: 1px dashed var(--faint);
    padding-top: 8px;
  }

  p {
    color: var(--pencil);
  }

  .entry {
    margin-bottom: 10px;
  }

  .project {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .swatches {
    display: flex;
    gap: 6px;
  }

  .swatch {
    width: 20px;
    height: 20px;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 50%;
    background: var(--swatch);
  }

  .swatch:hover {
    background: var(--swatch);
    border-color: rgb(255 255 255 / 70%);
  }

  .swatch[aria-checked="true"],
  .custom.picked {
    box-shadow:
      0 0 0 2px var(--paper),
      0 0 0 3.5px var(--swatch);
  }

  /* struck-through blank: back to colourless */
  .none,
  .none:hover {
    --swatch: var(--pencil);
    border: 1px solid var(--faint);
    background:
      linear-gradient(
        to top right,
        transparent 44%,
        var(--accent) 44% 56%,
        transparent 56%
      ),
      #fff;
  }

  /* rainbow until a colour is picked; the native input fills it invisibly */
  .custom {
    position: relative;
    cursor: pointer;
    background: conic-gradient(#d33, #db3, #3b3, #3bb, #33d, #b3b, #d33);
  }

  .custom.picked {
    background: var(--swatch);
  }

  .opacity {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    font-size: 15px;
    color: var(--pencil);
  }

  .opacity input {
    flex: 1;
    padding: 0;
    border: none;
    background: none;
    accent-color: var(--pencil);
  }

  .opacity span {
    min-width: 4ch;
    text-align: right;
  }

  .custom input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    opacity: 0;
    cursor: pointer;
  }

  .project input {
    flex: 1;
    min-width: 0;
  }

  .project input.tinted {
    background: var(--t-open-bg);
    color: var(--t-open-fg);
  }

  .count {
    min-width: 2ch;
    text-align: right;
    color: var(--pencil);
  }

  .delete {
    padding: 0 8px;
    font-size: 16px;
  }

  .delete:hover {
    color: var(--accent);
  }

  .close {
    float: right;
  }
</style>
