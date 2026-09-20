import { identityKey, type PortableProfile, type PortableState } from './types.ts';

/** A device exclusion retains identifiers only, never pull history or credentials. */
export interface DeviceExclusion {
  profile_id: string;
  identity: string | null;
}
function matches(profile: PortableProfile, exclusion: DeviceExclusion): boolean {
  return (
    profile.id === exclusion.profile_id ||
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
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error('Profile not found.');
  const next = [
    ...exclusions.filter((e) => !matches(profile, e)),
    { profile_id: profile.id, identity: identityKey(profile) }
  ];
  return { state: applyExclusions(state, next), exclusions: next };
}
