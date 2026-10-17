<script lang="ts">
  import { drag } from "./drag.svelte";
  import type { Task } from "./model";
  import ScheduleItem from "./ScheduleItem.svelte";

  interface Props {
    /** the enclosing `data-zone`; decides where the drop slot opens */
    zone: string;
    tasks: Task[];
    /** whether a drop lands where it is released (days) or by rank (backlog) */
    ordered?: boolean;
    /** per-task label, e.g. the original day of an overdue task */
    labelOf?: (task: Task) => string;
    unschedulable?: boolean;
    empty?: string;
  }
  const {
    zone,
    tasks,
    ordered = true,
    labelOf,
    unschedulable = false,
    empty = "",
  }: Props = $props();

  /** the lifted scrap stays mounted (hidden) so its touch stream survives */
  const rows = $derived.by(() => {
    let n = 0;
    return tasks.map((task) => ({
      task,
      at: task.id === drag.current?.id ? -1 : n++,
    }));
  });
  const visible = $derived(rows.filter((r) => r.at !== -1).length);
  const slot = $derived(
    ordered && drag.current?.zone === zone ? drag.current.index : -1,
  );
</script>

<div class="list">
  {#each rows as { task, at } (task.id)}
    {#if at !== -1 && at === slot}
      <div class="slot"></div>
    {/if}
    <ScheduleItem {task} label={labelOf?.(task)} {unschedulable} />
  {/each}
  {#if slot === visible}
    <div class="slot"></div>
  {/if}
  {#if visible === 0 && slot === -1 && empty !== ""}
    <div class="empty">{empty}</div>
  {/if}
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .slot {
    height: 28px;
    margin: 2px 4px;
    border: 1.5px dashed var(--pencil);
    border-radius: 4px;
    background: rgb(from var(--highlight) r g b / 45%);
  }

  .empty {
    padding: 4px 8px;
    color: var(--faint);
    font-size: 15px;
  }
</style>
