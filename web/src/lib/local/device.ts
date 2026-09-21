import {
  identityKey,
  profileIds,
  MAX_PROFILE_ALIASES,
  type PortableProfile,
  type PortableState
} from './types.ts';

/** A device exclusion retains identifiers only, never pull history or credentials. */
export interface DeviceExclusion {
  profile_id: string;
  aliases?: string[];
  identity: string | null;
}
function matches(profile: PortableProfile, exclusion: DeviceExclusion): boolean {
  return (
    profileIds(profile).some((id) =>
      [exclusion.profile_id, ...(exclusion.aliases || [])].includes(id)
    ) ||
    (exclusion.identity !== null && identityKey(profile) === exclusion.identity)
  );
}
export function applyExclusions(
  state: PortableState,
  exclusions: DeviceExclusion[]
): PortableState {
  return {
    ...state,
    profiles: state.profiles.filter(
      (profile) => !exclusions.some((exclusion) => matches(profile, exclusion))
    )
  };
}
/** Learn IDs before hiding a profile so a later partial offline copy stays hidden. */
export function retainExclusionAliases(
  state: PortableState,
  exclusions: DeviceExclusion[]
): DeviceExclusion[] {
  let references = 0;
  return exclusions.map((exclusion) => {
    const profiles = state.profiles.filter((profile) => matches(profile, exclusion));
    const identities = new Set(
      [exclusion.identity, ...profiles.map(identityKey)].filter((identity) => identity !== null)
    );
    if (identities.size > 1)
      throw new Error('A device exclusion refers to conflicting game accounts.');
    const aliases = [
      ...new Set([
        exclusion.profile_id,
        ...(exclusion.aliases || []),
        ...profiles.flatMap(profileIds)
      ])
    ].sort();
    references += aliases.length;
    if (references > MAX_PROFILE_ALIASES) throw new Error('Too many device exclusion aliases.');
    return { ...exclusion, aliases, identity: [...identities][0] ?? null };
  });
}
export function restoreExclusions(
  exclusions: DeviceExclusion[],
  restored: PortableState
): DeviceExclusion[] {
  return exclusions.filter(
    (exclusion) => !restored.profiles.some((profile) => matches(profile, exclusion))
  );
}
export function removeFromDevice(
  state: PortableState,
  profileId: string,
  exclusions: DeviceExclusion[]
): { state: PortableState; exclusions: DeviceExclusion[] } {
  const profile = state.profiles.find((p) => profileIds(p).includes(profileId));
  if (!profile) throw new Error('Profile not found.');
  const next = [
    ...exclusions.filter((e) => !matches(profile, e)),
    { profile_id: profile.id, aliases: profileIds(profile), identity: identityKey(profile) }
  ];
  return { state: applyExclusions(state, next), exclusions: next };
}
