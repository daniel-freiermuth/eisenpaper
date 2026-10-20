<script lang="ts">
  import { store } from "./sheet.svelte";

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
      <div class="entry">
        <div class="project">
          <input
            aria-label="project name"
            value={project.name}
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

  .project input {
    flex: 1;
    min-width: 0;
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
