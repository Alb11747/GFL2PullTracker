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
  updated_at: string;
  snapshots: SourceSnapshot[];
}
export interface Deletion {
  profile_id: string;
  deleted_at: string;
  identity: string | null;
}
export interface PortableState {
  format: 'gfl2-pull-tracker';
  version: 1;
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
  return { format: 'gfl2-pull-tracker', version: 1, profiles: [], settings: {}, tombstones: [] };
}
/** Partial identities must never match independently created profiles during sync. */
export function identityKey(profile: Identity): string | null {
  return IDENTITY_FIELDS.every((key) => profile[key] !== null && profile[key] !== '')
    ? JSON.stringify(IDENTITY_FIELDS.map((key) => profile[key]))
    : null;
}
