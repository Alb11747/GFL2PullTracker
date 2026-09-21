import {
  deletionIds,
  IDENTITY_FIELDS,
  identityKey,
  MAX_PROFILE_ALIASES,
  profileIds,
  type Identity,
  type PortableState
} from '../local/types.ts';
import { canonical, type Resolutions, type SyncConflict } from './reconcile.ts';

// A large legacy graph must not retain its source documents or grow unbounded metadata.
export const MAX_LINEAGE_IDENTIFIERS = 100_000;
export const MAX_LINEAGE_BINDINGS = 200_000;

type Binding = Identity;
const unknownBinding = (): Binding => ({
  account_fingerprint: null,
  endpoint_host: null,
  server: null,
  game_channel_id: null
});
const bindingOf = (value: Identity): Binding =>
  Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, value[field]])) as Binding;
const incompatible = (a: Binding, b: Binding): boolean =>
  IDENTITY_FIELDS.some((field) => a[field] !== null && b[field] !== null && a[field] !== b[field]);
const complete = (a: Binding, b: Binding): Binding =>
  Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, a[field] ?? b[field]])) as Binding;

/** Inputs must already have passed archive validation and original checksum verification. */
export function createLineageIndex() {
  const bindings = new Map<string, Map<string, Binding>>();
  const parents = new Map<string, string>();
  let bindingCount = 0;

  const root = (id: string): string => {
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current)!;
    while (parents.get(id) !== id) {
      const next = parents.get(id)!;
      parents.set(id, current);
      id = next;
    }
    return current;
  };

  function addBinding(ids: string[], binding: Binding) {
    const key = canonical(binding);
    for (const id of ids) {
      let known = bindings.get(id);
      if (!known) {
        if (bindings.size >= MAX_LINEAGE_IDENTIFIERS)
          throw new Error('Drive history identifier limit exceeded.');
        known = new Map();
        bindings.set(id, known);
        parents.set(id, id);
      }
      if (!known.has(key)) {
        if (bindingCount >= MAX_LINEAGE_BINDINGS)
          throw new Error('Drive history identity limit exceeded.');
        known.set(key, binding);
        bindingCount++;
      }
    }
    // Unlike shared partial identity fields, explicit v2 aliases establish ownership.
    // Resolve contradictory historical claims for the entire alias component together.
    for (const id of ids.slice(1)) {
      const left = root(ids[0]);
      const right = root(id);
      if (left !== right) parents.set(right, left);
    }
  }

  return {
    add(state: PortableState): void {
      for (const profile of state.profiles) addBinding(profileIds(profile), bindingOf(profile));
      for (const deletion of state.tombstones) {
        const values =
          deletion.identity === null ? null : (JSON.parse(deletion.identity) as string[]);
        const binding = values
          ? (Object.fromEntries(
              IDENTITY_FIELDS.map((field, index) => [field, values[index]])
            ) as Binding)
          : unknownBinding();
        addBinding(deletionIds(deletion), binding);
      }
    },

    recover(
      input: PortableState,
      resolutions: Resolutions = {}
    ): { state: PortableState; conflicts: SyncConflict[] } {
      const conflicts: SyncConflict[] = [];
      const selected = new Map<string, Binding>();
      const identities = new Map<string, Set<string>>();
      const components = new Map<string, { ids: string[]; evidence: Map<string, Binding> }>();
      for (const [id, evidence] of bindings) {
        const key = root(id);
        const component = components.get(key) ?? {
          ids: [] as string[],
          evidence: new Map<string, Binding>()
        };
        component.ids.push(id);
        for (const [key, value] of evidence) component.evidence.set(key, value);
        components.set(key, component);
      }
      const ordered = [...components.values()]
        .map((component) => ({
          ...component,
          ids: component.ids.sort()
        }))
        .sort((a, b) => a.ids[0].localeCompare(b.ids[0]));

      // Stable evidence ordering makes choices independent of download order and of which
      // revision is being recovered. Partial observations complete only the same known ID.
      for (const { ids: componentIds, evidence } of ordered) {
        const id = componentIds[0];
        const observations = [...evidence].sort(([a], [b]) => a.localeCompare(b));
        let binding = unknownBinding();
        let unresolved = false;
        for (const [, observed] of observations) {
          if (!incompatible(binding, observed)) {
            binding = complete(binding, observed);
            continue;
          }
          const fingerprint = canonical({
            ids: componentIds,
            evidence: observations,
            local: binding,
            remote: observed
          });
          const conflictId = `lineage-identity:${id}:${canonical([binding, observed])}`;
          const resolution = resolutions[conflictId];
          if (resolution?.fingerprint === fingerprint) {
            if (resolution.choice === 'remote') binding = observed;
          } else {
            conflicts.push({
              id: conflictId,
              fingerprint,
              kind: 'identity',
              profileName: `Historical profile ${id}`,
              localLabel: `Bind historical ID to ${identityKey(binding) ?? canonical(binding)}`,
              remoteLabel: `Bind historical ID to ${identityKey(observed) ?? canonical(observed)}`
            });
            unresolved = true;
            break;
          }
        }
        if (unresolved) continue;
        for (const id of componentIds) selected.set(id, binding);
        const identity = identityKey(binding);
        if (identity !== null) {
          const ids = identities.get(identity) ?? new Set<string>();
          for (const id of componentIds) ids.add(id);
          identities.set(identity, ids);
        }
      }

      const expand = (original: string[], binding: Binding): string[] => {
        const ids = new Set(original);
        const candidates = new Set<string>();
        const currentIdentity = identityKey(binding);
        if (currentIdentity !== null) candidates.add(currentIdentity);
        for (const id of original) {
          const historical = selected.get(id);
          if (historical && !incompatible(binding, historical)) {
            const identity = identityKey(complete(binding, historical));
            if (identity !== null) candidates.add(identity);
          }
        }
        // Multiple incompatible completions can only arise from contradictory alias
        // ownership. Do not infer a connection between those accounts.
        if (candidates.size === 1)
          for (const id of identities.get([...candidates][0]) ?? []) ids.add(id);
        if (ids.size > MAX_PROFILE_ALIASES)
          throw new Error('Recovered profile alias limit exceeded.');
        return [...ids].sort();
      };
      const state = structuredClone(input);
      state.version = 2;
      for (const profile of state.profiles) profile.aliases = expand(profileIds(profile), profile);
      for (const deletion of state.tombstones) {
        const values =
          deletion.identity === null ? null : (JSON.parse(deletion.identity) as string[]);
        const binding = values
          ? (Object.fromEntries(
              IDENTITY_FIELDS.map((field, index) => [field, values[index]])
            ) as Binding)
          : unknownBinding();
        deletion.aliases = expand(deletionIds(deletion), binding);
      }
      return { state, conflicts };
    }
  };
}
