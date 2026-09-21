import {
  emptyState,
  identityKey,
  IDENTITY_FIELDS,
  profileIds,
  deletionIds,
  type Deletion,
  type PortableProfile,
  type PortableState
} from '../local/types.ts';

export interface SyncConflict {
  id: string;
  kind: 'rename' | 'identity' | 'delete-edit' | 'setting';
  profileName: string;
  localLabel: string;
  remoteLabel: string;
  /** Exact alternatives, including immutable history, to which a choice applies. */
  fingerprint: string;
}
export type Choices = Record<string, 'local' | 'remote'>;
export type Resolutions = Record<string, { choice: 'local' | 'remote'; fingerprint: string }>;
export const PORTABLE_SETTINGS = ['theme', 'locale', 'page_size'] as const;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function incompatible(a: PortableProfile, b: PortableProfile): boolean {
  return IDENTITY_FIELDS.some((key) => a[key] !== null && b[key] !== null && a[key] !== b[key]);
}
function content(profile: PortableProfile): string {
  return canonical({
    name: profile.name,
    identity: IDENTITY_FIELDS.map((key) => profile[key]),
    snapshots: profile.snapshots.map((s) => s.digest).sort()
  });
}
function mergeSnapshots(profiles: PortableProfile[]): PortableProfile['snapshots'] {
  const snapshots = new Map<string, PortableProfile['snapshots'][number]>();
  for (const profile of profiles)
    for (const snapshot of profile.snapshots) {
      const known = snapshots.get(snapshot.digest);
      if (
        !known ||
        snapshot.imported_at < known.imported_at ||
        (snapshot.imported_at === known.imported_at && snapshot.id < known.id)
      )
        snapshots.set(snapshot.digest, snapshot);
    }
  return [...snapshots.values()].sort(
    (a, b) => a.imported_at.localeCompare(b.imported_at) || a.digest.localeCompare(b.digest)
  );
}
function collapse(profiles: PortableProfile[]): PortableProfile | undefined {
  if (!profiles.length) return undefined;
  const result = structuredClone(profiles[0]);
  const ids = [...new Set(profiles.flatMap(profileIds))].sort();
  result.id = ids[0];
  result.aliases = ids;
  result.created_at = profiles.map((p) => p.created_at).sort()[0];
  result.updated_at = profiles
    .map((p) => p.updated_at)
    .sort()
    .at(-1)!;
  result.snapshots = mergeSnapshots(profiles);
  for (const p of profiles) for (const field of IDENTITY_FIELDS) result[field] ??= p[field];
  return result;
}
function deletionMatches(d: Deletion, ids: Set<string>, identities: Set<string>): boolean {
  return (
    deletionIds(d).some((id) => ids.has(id)) || (d.identity !== null && identities.has(d.identity))
  );
}

/** Three-way reconciliation. Snapshots are immutable; the local worker derives occurrence counts. */
export function reconcile(
  local: PortableState,
  remote: PortableState,
  base: PortableState = emptyState(),
  resolutions: Resolutions = {}
): { state: PortableState; conflicts: SyncConflict[] } {
  const conflicts: SyncConflict[] = [];
  const conflict = (
    kind: SyncConflict['kind'],
    key: string,
    name: string,
    localLabel: string,
    remoteLabel: string,
    alternatives: unknown
  ) => {
    const id = `${kind}:${key}`;
    const fingerprint = canonical({ kind, alternatives });
    const resolution = resolutions[id];
    if (resolution?.fingerprint === fingerprint) return resolution.choice;
    conflicts.push({ id, kind, profileName: name, localLabel, remoteLabel, fingerprint });
    return null;
  };
  const groups: { profiles: PortableProfile[]; ids: Set<string>; identities: Set<string> }[] = [];
  for (const profile of [...local.profiles, ...remote.profiles, ...base.profiles]) {
    const identity = identityKey(profile);
    const matches = groups.filter(
      (g) =>
        profileIds(profile).some((id) => g.ids.has(id)) ||
        (identity !== null && g.identities.has(identity))
    );
    const group = matches[0] ?? {
      profiles: [],
      ids: new Set<string>(),
      identities: new Set<string>()
    };
    if (!matches.length) groups.push(group);
    for (const other of matches.slice(1)) {
      group.profiles.push(...other.profiles);
      other.ids.forEach((id) => group.ids.add(id));
      other.identities.forEach((id) => group.identities.add(id));
      groups.splice(groups.indexOf(other), 1);
    }
    group.profiles.push(profile);
    profileIds(profile).forEach((id) => group.ids.add(id));
    if (identity) group.identities.add(identity);
  }
  const state = emptyState();
  let tombstones = structuredClone([...local.tombstones, ...remote.tombstones]);

  const mergeProfiles = (
    leftProfiles: PortableProfile[],
    rightProfiles: PortableProfile[],
    ancestors: PortableProfile[],
    forceDeletionChoice = false
  ) => {
    const current = [...leftProfiles, ...rightProfiles];
    if (!current.length) return;
    // Rejected identity alternatives must not contribute history or aliases.
    const safeAncestors = ancestors.filter((p) =>
      current.every((other) => !incompatible(p, other))
    );
    const ids = new Set([...current, ...safeAncestors].flatMap(profileIds));
    const identities = new Set(
      [...current, ...safeAncestors].map(identityKey).filter((id): id is string => id !== null)
    );
    const key = [...ids].sort()[0];
    const left = collapse(leftProfiles);
    const right = collapse(rightProfiles);
    const ancestor = collapse(safeAncestors);
    const sample = left ?? right!;
    const matches = (d: Deletion) => deletionMatches(d, ids, identities);
    const leftDeletes = local.tombstones.filter(matches);
    const rightDeletes = remote.tombstones.filter(matches);
    for (const deletion of [...leftDeletes, ...rightDeletes])
      deletionIds(deletion).forEach((id) => ids.add(id));
    const alternatives = {
      local: leftProfiles,
      remote: rightProfiles,
      base: safeAncestors,
      leftDeletes,
      rightDeletes
    };
    if (leftDeletes.length || rightDeletes.length) {
      const deletionSide = leftDeletes.length ? 'local' : 'remote';
      const live = deletionSide === 'local' ? right : left;
      let choice: 'local' | 'remote' | null = deletionSide;
      if (live && (forceDeletionChoice || !ancestor || content(live) !== content(ancestor))) {
        choice = conflict(
          'delete-edit',
          key,
          sample.name,
          leftDeletes.length ? 'Delete on all devices' : `Keep ${sample.name}`,
          rightDeletes.length ? 'Delete on all devices' : `Keep ${sample.name}`,
          alternatives
        );
      }
      if (!choice) return;
      if (choice === deletionSide) {
        // Remember every compatible identity even when deletion wins before an ID merge.
        for (const deletion of tombstones.filter(matches)) {
          const allIds = [...new Set([...deletionIds(deletion), ...ids])].sort();
          deletion.profile_id = allIds[0];
          deletion.aliases = allIds;
          if (!deletion.identity && identities.size === 1) deletion.identity = [...identities][0];
        }
        return;
      }
      tombstones = tombstones.filter((d) => !matches(d));
      if (live) {
        const kept = structuredClone(live);
        kept.id = [...ids].sort()[0];
        kept.aliases = [...ids].sort();
        state.profiles.push(kept);
      }
      return;
    }
    const merged = collapse(current)!;
    merged.id = key;
    merged.aliases = [...ids].sort();
    if (left && right && left.name !== right.name) {
      if (ancestor?.name === left.name) merged.name = right.name;
      else if (ancestor?.name !== right.name) {
        const choice = conflict('rename', key, sample.name, left.name, right.name, alternatives);
        if (choice === 'remote') merged.name = right.name;
      }
    }
    state.profiles.push(merged);
  };

  for (const group of groups) {
    const match = (p: PortableProfile) => profileIds(p).some((id) => group.ids.has(id));
    const leftProfiles = local.profiles.filter(match);
    const rightProfiles = remote.profiles.filter(match);
    const currentProfiles = [...leftProfiles, ...rightProfiles];
    const ancestors = base.profiles.filter(match);
    if (
      currentProfiles.some((p, index) =>
        currentProfiles.slice(index + 1).some((other) => incompatible(p, other))
      )
    ) {
      const describe = (profiles: PortableProfile[]) =>
        profiles.map((p) => `${p.name}: ${identityKey(p) ?? p.id}`).join('; ') || 'No profile';
      const choice = conflict(
        'identity',
        [...group.ids].sort()[0],
        currentProfiles[0].name,
        describe(leftProfiles),
        describe(rightProfiles),
        {
          local: leftProfiles,
          remote: rightProfiles,
          base: ancestors,
          deletions: tombstones.filter((d) => deletionMatches(d, group.ids, group.identities))
        }
      );
      if (!choice) continue;
      const selected = choice === 'local' ? leftProfiles : rightProfiles;
      // A transitive collision can contain several unrelated accounts on the chosen side.
      // Preserve those accounts separately, then reconcile each with applicable deletions.
      for (const p of selected) {
        const pIds = new Set(profileIds(p));
        const identity = identityKey(p);
        const related = ancestors.filter(
          (a) =>
            profileIds(a).some((id) => pIds.has(id)) ||
            (identity !== null && identityKey(a) === identity)
        );
        mergeProfiles(choice === 'local' ? [p] : [], choice === 'remote' ? [p] : [], related, true);
      }
      continue;
    }
    mergeProfiles(leftProfiles, rightProfiles, ancestors);
  }

  // Coalesce deletion aliases transitively without losing the newest deletion timestamp.
  const mergedDeletions: Deletion[] = [];
  for (const deletion of tombstones) {
    const ids = new Set(deletionIds(deletion));
    const matches = mergedDeletions.filter(
      (d) =>
        (d.identity === null || deletion.identity === null || d.identity === deletion.identity) &&
        (deletionIds(d).some((id) => ids.has(id)) ||
          (deletion.identity !== null && d.identity === deletion.identity))
    );
    const items = [...matches, deletion];
    const allIds = [...new Set(items.flatMap(deletionIds))].sort();
    for (const match of matches) mergedDeletions.splice(mergedDeletions.indexOf(match), 1);
    mergedDeletions.push({
      profile_id: allIds[0],
      aliases: allIds,
      identity: items.find((d) => d.identity !== null)?.identity ?? null,
      deleted_at: items
        .map((d) => d.deleted_at)
        .sort()
        .at(-1)!
    });
  }
  state.profiles.sort((a, b) => a.id.localeCompare(b.id));
  state.tombstones = mergedDeletions.sort((a, b) => a.profile_id.localeCompare(b.profile_id));
  // Server consent, backup preferences, and credentials are deliberately not portable.
  for (const key of PORTABLE_SETTINGS) {
    const left = local.settings[key];
    const right = remote.settings[key];
    const ancestor = base.settings[key];
    let value = left ?? right;
    if (left !== undefined && right !== undefined && left !== right) {
      if (left === ancestor) value = right;
      else if (right !== ancestor) {
        const choice = conflict('setting', key, key, String(left), String(right), {
          local: left,
          remote: right,
          base: ancestor
        });
        if (choice === 'remote') value = right;
      }
    }
    if (value !== undefined) state.settings[key] = value;
  }
  return { state, conflicts };
}
