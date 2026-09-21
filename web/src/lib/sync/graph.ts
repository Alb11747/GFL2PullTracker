import type { Revision } from './drive.ts';

/** Missing parents are checkpoint boundaries, never evidence that a profile was deleted. */
export function inspectGraph(revisions: Revision[]) {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const invalid = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const members: string[] = [];
  const onStack = new Set<string>();
  let sequence = 0;
  // Iterative Tarjan traversal marks only cyclic components, not healthy
  // descendants whose complete snapshots can survive a corrupt parent.
  for (const start of byId.keys()) {
    if (indices.has(start)) continue;
    const frames: { id: string; next: number }[] = [];
    const enter = (id: string) => {
      indices.set(id, sequence);
      low.set(id, sequence++);
      members.push(id);
      onStack.add(id);
      frames.push({ id, next: 0 });
    };
    enter(start);
    while (frames.length) {
      const item = frames.at(-1)!;
      const parents = byId.get(item.id)!.parents;
      if (item.next < parents.length) {
        const parent = parents[item.next++];
        if (!byId.has(parent)) continue;
        if (!indices.has(parent)) enter(parent);
        else if (onStack.has(parent))
          low.set(item.id, Math.min(low.get(item.id)!, indices.get(parent)!));
        continue;
      }
      frames.pop();
      if (frames.length) {
        const previous = frames.at(-1)!.id;
        low.set(previous, Math.min(low.get(previous)!, low.get(item.id)!));
      }
      if (low.get(item.id) === indices.get(item.id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = members.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== item.id);
        if (component.length > 1 || parents.includes(item.id))
          for (const id of component) invalid.add(id);
      }
    }
  }
  for (const id of invalid) byId.delete(id);
  const parents = new Set([...byId.values()].flatMap((revision) => revision.parents));
  const heads = [...byId.values()]
    .filter((revision) => !parents.has(revision.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const common: Record<string, string | null> = {};
  // Single-head sync never builds ancestry sets. Branched histories retain only
  // an intersection and the current traversal instead of one set per revision.
  let intersection: Set<string> | undefined;
  let complete = true;
  for (const head of heads) {
    common[head.id] = null;
    if (heads.length === 1) break;
    const ancestors = new Set<string>();
    const pending = [head.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (ancestors.has(id)) continue;
      const revision = byId.get(id);
      if (!revision) {
        complete = false;
        continue;
      }
      ancestors.add(id);
      pending.push(...revision.parents);
    }
    if (intersection) {
      intersection = new Set([...intersection].filter((id) => ancestors.has(id)));
      if (complete) {
        const older = new Set([...intersection].flatMap((id) => byId.get(id)!.parents));
        const closest = [...intersection].filter((id) => !older.has(id));
        if (closest.length === 1) common[head.id] = closest[0];
      }
    } else intersection = ancestors;
  }
  return { heads, common, invalidIds: [...invalid] };
}
