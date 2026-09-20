import {
  emptyState,
  identityKey,
  IDENTITY_FIELDS,
  type Deletion,
  type PortableProfile,
  type PortableState
} from '../local/types.ts';

export interface SyncConflict {
  id: string;
  kind: 'rename' | 'identity' | 'delete-edit';
  profileName: string;
  localLabel: string;
  remoteLabel: string;
}
export type Resolutions = Record<string, 'local' | 'remote'>;
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

/** Three-way reconciliation. Snapshots are immutable; the local worker derives occurrence counts. */
export function reconcile(
  local: PortableState,
  remote: PortableState,
  base: PortableState = emptyState(),
  resolutions: Resolutions = {}
): { state: PortableState; conflicts: SyncConflict[] } {
  const conflicts: SyncConflict[] = [];
  const groups: { profiles: PortableProfile[]; ids: Set<string>; identities: Set<string> }[] = [];
  for (const profile of [...local.profiles, ...remote.profiles, ...base.profiles]) {
    const identity = identityKey(profile);
    const matches = groups.filter(
      (g) => g.ids.has(profile.id) || (identity !== null && g.identities.has(identity))
    );
    const group = matches[0] ?? {
      profiles: [],
      ids: new Set<string>(),
      identities: new Set<string>()
    };
    if (!matches.length) groups.push(group);
    for (const other of matches.slice(1)) {
      other.profiles.forEach((p) => group.profiles.push(p));
      other.ids.forEach((id) => group.ids.add(id));
      other.identities.forEach((id) => group.identities.add(id));
      groups.splice(groups.indexOf(other), 1);
    }
    group.profiles.push(profile);
    group.ids.add(profile.id);
    if (identity) group.identities.add(identity);
  }
  const state = emptyState();
  const tombstones = new Map<string, Deletion>();
  for (const item of [...local.tombstones, ...remote.tombstones]) {
    const key = item.identity ?? item.profile_id;
    if (!tombstones.has(key) || tombstones.get(key)!.deleted_at < item.deleted_at)
      tombstones.set(key, item);
  }
  const conflict = (
    kind: SyncConflict['kind'],
    key: string,
    name: string,
    localLabel: string,
    remoteLabel: string
  ) => {
    const id = `${kind}:${key}`;
    if (resolutions[id]) return resolutions[id];
    conflicts.push({ id, kind, profileName: name, localLabel, remoteLabel });
    return null;
  };
  for (const group of groups) {
    const match = (p: PortableProfile) => group.ids.has(p.id);
    const leftProfiles = local.profiles.filter(match);
    const rightProfiles = remote.profiles.filter(match);
    const currentProfiles = [...leftProfiles, ...rightProfiles];
    const key = [...group.ids].sort()[0];
    // Matching an ID and an identity can connect several profiles transitively.
    // Detect conflicting bindings before collapsing that group, never after mixing its snapshots.
    if (
      currentProfiles.some((profile, index) =>
        currentProfiles.slice(index + 1).some((other) => incompatible(profile, other))
      )
    ) {
      const describe = (profiles: PortableProfile[]) =>
        profiles.map((p) => `${p.name}: ${identityKey(p) ?? p.id}`).join('; ') || 'No profile';
      const choice = conflict(
        'identity',
        key,
        currentProfiles[0].name,
        describe(leftProfiles),
        describe(rightProfiles)
      );
      if (choice)
        state.profiles.push(...structuredClone(choice === 'local' ? leftProfiles : rightProfiles));
      continue;
    }
    const collapse = (profiles: PortableProfile[]) => {
      const found = profiles.filter(match);
      if (!found.length) return undefined;
      const first = structuredClone(found[0]);
      // A device may intentionally have multiple profiles for one known game account.
      // Their histories must all survive identity matching, including before the first sync.
      first.snapshots = mergeSnapshots(found);
      return first;
    };
    const left = collapse(local.profiles);
    const right = collapse(remote.profiles);
    const ancestor = base.profiles.find(match);
    if (!left && !right) continue;
    const sample = left ?? right!;
    const isDeleted = (d: Deletion) =>
      group.ids.has(d.profile_id) || (d.identity !== null && group.identities.has(d.identity));
    const leftDelete = local.tombstones.find(isDeleted);
    const rightDelete = remote.tombstones.find(isDeleted);
    if (leftDelete || rightDelete) {
      const live = leftDelete ? right : left;
      const deletionSide = leftDelete ? 'local' : 'remote';
      let choice: 'local' | 'remote' | null = deletionSide;
      if (live && (!ancestor || content(live) !== content(ancestor))) {
        choice = conflict(
          'delete-edit',
          key,
          sample.name,
          leftDelete ? 'Delete on all devices' : `Keep ${sample.name}`,
          rightDelete ? 'Delete on all devices' : `Keep ${sample.name}`
        );
      }
      if (!choice || choice === deletionSide) continue;
      for (const [tkey, deletion] of tombstones) if (isDeleted(deletion)) tombstones.delete(tkey);
      if (live) state.profiles.push(structuredClone(live));
      continue;
    }
    if (!left || !right) {
      state.profiles.push(structuredClone(sample));
      continue;
    }
    if (incompatible(left, right)) {
      const choice = conflict(
        'identity',
        key,
        sample.name,
        `${left.name}: ${identityKey(left) ?? left.id}`,
        `${right.name}: ${identityKey(right) ?? right.id}`
      );
      if (choice) state.profiles.push(structuredClone(choice === 'local' ? left : right));
      continue;
    }
    let name = left.name;
    if (left.name !== right.name) {
      if (ancestor?.name === left.name) name = right.name;
      else if (ancestor?.name !== right.name) {
        const choice = conflict('rename', key, sample.name, left.name, right.name);
        if (choice === 'remote') name = right.name;
      }
    }
    const merged = structuredClone(left);
    merged.name = name;
    merged.id = [left.id, right.id].sort()[0];
    merged.created_at = [left.created_at, right.created_at].sort()[0];
    merged.updated_at = [left.updated_at, right.updated_at].sort().at(-1)!;
    for (const field of IDENTITY_FIELDS) merged[field] ??= right[field];
    merged.snapshots = mergeSnapshots([left, right]);
    state.profiles.push(merged);
  }
  state.profiles.sort((a, b) => a.id.localeCompare(b.id));
  state.tombstones = [...tombstones.values()].sort((a, b) =>
    a.profile_id.localeCompare(b.profile_id)
  );
  // Server backup and analytics preferences are deliberately not portable.
  for (const key of PORTABLE_SETTINGS) {
    const value = local.settings[key] ?? remote.settings[key];
    if (value !== undefined) state.settings[key] = value;
  }
  return { state, conflicts };
}
