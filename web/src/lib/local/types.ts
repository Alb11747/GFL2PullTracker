import type { Profile } from '../api.ts';

/** Portable data never contains game captures, OAuth tokens, or server trust claims. */
export interface SourceSnapshot {
  id: string;
  digest: string;
  document: Record<string, unknown>;
  manifest: Record<string, unknown> | null;
  raw_pages: Record<string, string> | null;
  imported_at: string;
}
export interface PortableProfile extends Profile {
  /** Every historical profile ID, including the canonical ID. */
  aliases: string[];
  updated_at: string;
  snapshots: SourceSnapshot[];
}
export interface Deletion {
  profile_id: string;
  aliases: string[];
  deleted_at: string;
  identity: string | null;
}
export interface PortableState {
  format: 'gfl2-pull-tracker';
  version: 1 | 2;
  profiles: PortableProfile[];
  settings: Record<string, string | number | boolean>;
  tombstones: Deletion[];
}
export type Identity = Pick<
  Profile,
  'account_fingerprint' | 'endpoint_host' | 'server' | 'game_channel_id'
>;
export const IDENTITY_FIELDS = [
  'account_fingerprint',
  'endpoint_host',
  'server',
  'game_channel_id'
] as const;
export const OFFICIAL_HOSTS = new Set([
  'gf2-gacha-record-us.sunborngame.com',
  'gf2-gacha-record.sunborngame.com',
  'gf2-gacha-record-asia.haoplay.com',
  'gf2-gacha-record-jp.haoplay.com',
  'gf2-gacha-record-kr.haoplay.com',
  'gf2-gacha-record-intl.haoplay.com'
]);
export function emptyState(): PortableState {
  return { format: 'gfl2-pull-tracker', version: 2, profiles: [], settings: {}, tombstones: [] };
}
export const MAX_PROFILE_ALIASES = 10_000;
/** Legacy input is supported only at the validated migration boundary. */
export function profileIds(
  profile: Pick<PortableProfile, 'id'> & { aliases?: string[] }
): string[] {
  return [...new Set([profile.id, ...(profile.aliases || [])])].sort();
}
export function deletionIds(
  deletion: Pick<Deletion, 'profile_id'> & { aliases?: string[] }
): string[] {
  return [...new Set([deletion.profile_id, ...(deletion.aliases || [])])].sort();
}
/** Partial identities must never match independently created profiles during sync. */
export function identityKey(profile: Identity): string | null {
  return IDENTITY_FIELDS.every((key) => profile[key] !== null && profile[key] !== '')
    ? JSON.stringify(IDENTITY_FIELDS.map((key) => profile[key]))
    : null;
}
