import catalog from '../../../../backend/catalog.json' with { type: 'json' };
import type {
  Filters,
  FilterOptions,
  History,
  ImportInput,
  ImportResult,
  Profile,
  Pull,
  Statistics
} from '../api.ts';
import {
  emptyState,
  IDENTITY_FIELDS,
  identityKey,
  OFFICIAL_HOSTS,
  type Identity,
  type PortableProfile,
  type PortableState,
  type SourceSnapshot
} from './types.ts';

export const MAX_STATE_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDS = 500_000;
const items = new Map(catalog.items.map((item) => [item.id, item]));
type JsonObject = Record<string, unknown>;
interface Entry {
  source_type_id: number;
  source_page: number;
  record: JsonObject;
}
interface Row extends Pull {
  key: string;
  occurrence: number;
  token: string;
}
const blocked =
  /^(authorization|cookie|token|capture|account_value|original_url|headers|access_token|refresh_token|id_token|session|session_id|csrf|csrf_token|verified|verified_at|server_verified|verification|trusted)$/i;
export function object(value: unknown, label = 'value'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  return value as JsonObject;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = object(value, 'JSON');
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(',')}}`;
}
export function noCredentials(value: unknown, depth = 0): void {
  if (depth > 50) throw new Error('Archive is nested too deeply.');
  if (
    typeof value === 'string' &&
    (/\bBearer\s+[A-Za-z0-9._~-]{8,}/i.test(value) ||
      /[?&](?:token|access_token|auth|authorization|cookie)=/i.test(value))
  )
    throw new Error('Archive contains credentials. Export records without request captures.');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (blocked.test(key))
        throw new Error('Archive contains credentials or server verification claims.');
      noCredentials(child, depth + 1);
    }
  }
}
function integer(value: unknown, label: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new Error(`Invalid ${label}.`);
  return value;
}
function date(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`Invalid ${label}; use an ISO timestamp with timezone.`);
  return value;
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}.`);
  return value;
}
function identity(value: JsonObject): Identity {
  const result = {} as Identity;
  for (const key of IDENTITY_FIELDS)
    result[key] = value[key] == null ? null : text(value[key], 'profile identity');
  if (
    result.account_fingerprint !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(result.account_fingerprint)
  )
    throw new Error('Invalid account fingerprint.');
  if (result.endpoint_host !== null && !OFFICIAL_HOSTS.has(result.endpoint_host))
    throw new Error('Unknown game endpoint host.');
  for (const key of ['server', 'game_channel_id'] as const)
    if (result[key] !== null && !/^\d+$/.test(result[key]))
      throw new Error('Invalid server or channel.');
  return result;
}
function bind(profile: Identity, incoming: Identity): void {
  for (const key of IDENTITY_FIELDS) {
    if (profile[key] !== null && incoming[key] !== null && incoming[key] !== profile[key])
      throw new Error(
        'This data belongs to a different account, server, or channel. Choose another profile.'
      );
  }
  for (const key of IDENTITY_FIELDS) if (incoming[key] !== null) profile[key] = incoming[key];
}
function entries(document: JsonObject): Entry[] {
  const rows = document.records as Entry[];
  return (document.external_source as JsonObject | undefined)?.source === 'https://exilium.xyz'
    ? [...rows].reverse()
    : rows;
}
export function validateDocument(
  document: JsonObject,
  manifest: JsonObject | null = null,
  rawPages: Record<string, string> | null = null
): Identity {
  noCredentials([document, manifest, rawPages]);
  if (![1, 2].includes(document.schema_version as number))
    throw new Error('Unsupported export schema version; expected 1 or 2.');
  date(document.exported_at, 'export date');
  if (!Array.isArray(document.records) || document.records.length > MAX_RECORDS)
    throw new Error('Export records must contain at most 500,000 records.');
  const id = identity(document);
  // Legacy records can be deliberately assigned to a selected profile. They may
  // remain unbound, but can never independently match a different synced profile.
  if (document.schema_version === 2 && IDENTITY_FIELDS.some((key) => id[key] === null))
    throw new Error('Version 2 exports need a complete collector identity.');
  const counts = new Map<number, number>();
  const expected = new Map<string, unknown[]>();
  for (const input of document.records) {
    const entry = object(input, 'source record');
    const raw = object(entry.record, 'raw record');
    const type = integer(entry.source_type_id, 'source type');
    const page = integer(entry.source_page, 'source page');
    integer(raw.item, 'item ID', true);
    integer(raw.pool_id, 'pool ID', true);
    integer(raw.item_num, 'quantity', true);
    const timestamp = integer(raw.time, 'timestamp', true);
    if (!Number.isFinite(new Date(timestamp * 1000).valueOf()) || timestamp > 253402300799)
      throw new Error('Invalid timestamp.');
    counts.set(type, (counts.get(type) || 0) + 1);
    const key = `${type}/${page}`;
    const group = expected.get(key) || [];
    group.push(raw);
    expected.set(key, group);
  }
  if (manifest !== null) {
    if (
      manifest.schema_version !== document.schema_version ||
      typeof manifest.complete !== 'boolean'
    )
      throw new Error('Invalid manifest schema or collection status.');
    date(manifest.started_at, 'manifest start date');
    if (manifest.completed_at != null) date(manifest.completed_at, 'manifest completion date');
    if (manifest.complete && manifest.completed_at == null)
      throw new Error('Completed manifest needs a completion date.');
    if (manifest.started_at !== document.exported_at)
      throw new Error('Manifest and records belong to different runs.');
    for (const key of IDENTITY_FIELDS)
      if (manifest[key] != null && manifest[key] !== id[key])
        throw new Error('Manifest identity does not match the records.');
    const types = object(manifest.types, 'manifest types');
    for (const [key, input] of Object.entries(types)) {
      const value = object(input, 'manifest type');
      if (
        !/^[1-9][0-9]{0,18}$/.test(key) ||
        !['complete', 'empty', 'unavailable', 'in_progress', 'error'].includes(
          value.status as string
        )
      )
        throw new Error('Invalid manifest type status.');
      integer(value.pages, 'manifest pages', true);
      integer(value.records, 'manifest records', true);
      if (value.records !== (counts.get(Number(key)) || 0))
        throw new Error('Manifest counts do not match the records.');
      if (
        manifest.complete &&
        !['complete', 'empty', 'unavailable'].includes(value.status as string)
      )
        throw new Error('Completed manifest contains an unfinished type.');
    }
    for (const row of document.records as Entry[]) {
      const status = types[String(row.source_type_id)] as JsonObject | undefined;
      if (!status || row.source_page > Number(status.pages))
        throw new Error('Record provenance exceeds manifest pages.');
    }
  }
  if (rawPages !== null) {
    const seen = new Set<string>();
    for (const [path, contents] of Object.entries(rawPages)) {
      const match = /^(?:raw|responses)\/type_(\d+)\/page_(\d+)\.json$/.exec(path);
      if (!match || typeof contents !== 'string')
        throw new Error('Invalid raw page archive name or content.');
      const parsed = object(JSON.parse(contents.replace(/^\uFEFF/, '')), 'raw page');
      noCredentials(parsed);
      const list = object(parsed.data, 'raw page data').list;
      if (!Array.isArray(list)) throw new Error('Raw pages must contain response record arrays.');
      // Incremental collectors also preserve original network responses. Those
      // can include overlap stripped from the normalized raw page archive.
      if (path.startsWith('responses/')) continue;
      const key = `${Number(match[1])}/${Number(match[2])}`;
      if (
        !Array.isArray(list) ||
        seen.has(key) ||
        canonical(list) !== canonical(expected.get(key) || [])
      )
        throw new Error('Raw page records do not match snapshot provenance.');
      seen.add(key);
    }
    if ([...expected.keys()].some((key) => !seen.has(key)))
      throw new Error('Raw archive is missing referenced pages.');
  }
  if (new TextEncoder().encode(canonical([document, manifest, rawPages])).length > MAX_STATE_BYTES)
    throw new Error('Import exceeds the 64 MiB expanded limit.');
  return id;
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function mergeSourceOrder(existing: string[], incoming: string[]): string[] {
  const known = new Set(existing);
  const received = new Set(incoming);
  if (existing.every((token) => received.has(token))) return [...incoming];
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const token of incoming) {
    if (known.has(token)) {
      if (pending.length) {
        before.set(token, pending);
        pending = [];
      }
    } else {
      pending.push(token);
      known.add(token);
    }
  }
  const merged: string[] = [];
  for (const token of existing) {
    for (const addition of before.get(token) || []) merged.push(addition);
    merged.push(token);
  }
  return merged.concat(pending);
}
function increment(map: Map<string, number>, key: string): number {
  const n = (map.get(key) || 0) + 1;
  map.set(key, n);
  return n;
}
function token(type: number, key: string, occurrence: number): string {
  return canonical([type, key, occurrence]);
}
function buildRows(profile: PortableProfile): Row[] {
  const saved = new Map<string, Row>();
  const groups = new Map<string, string[]>();
  for (const snapshot of profile.snapshots) {
    const observed = new Map<string, number>();
    const incoming = new Map<string, string[]>();
    for (const entry of entries(snapshot.document)) {
      const raw = entry.record;
      const type = entry.source_type_id;
      const key = canonical(raw);
      const occurrence = increment(observed, canonical([type, key]));
      const id = token(type, key, occurrence);
      const timestamp = new Date(Number(raw.time) * 1000).toISOString().replace('.000Z', 'Z');
      const group = canonical([type, timestamp]);
      const order = incoming.get(group) || [];
      order.push(id);
      incoming.set(group, order);
      if (!saved.has(id)) {
        const item = items.get(Number(raw.item));
        saved.set(id, {
          id: saved.size + 1,
          item_id: Number(raw.item),
          name: item?.name || `Unknown item #${raw.item}`,
          kind: item?.kind || 'unknown',
          rarity: item?.rarity || 'Unknown',
          region: item?.region || null,
          type_id: type,
          pool_id: Number(raw.pool_id),
          timestamp,
          timestamp_order: 0,
          quantity: Number(raw.item_num),
          source_page: entry.source_page,
          estimated_group_size: 1,
          pity: 0,
          pity_uncertain: true,
          gap_before: false,
          key,
          occurrence,
          token: id
        });
      }
    }
    for (const [group, order] of incoming) {
      const merged = mergeSourceOrder(groups.get(group) || [], order);
      groups.set(group, merged);
      merged.forEach((id, position) => {
        saved.get(id)!.timestamp_order = position;
      });
    }
  }
  const rows = [...saved.values()].sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) ||
      a.timestamp_order - b.timestamp_order ||
      a.type_id - b.type_id ||
      a.id - b.id
  );
  const multi = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    increment(multi, canonical([row.type_id, row.pool_id, row.timestamp]));
    increment(counts, canonical([row.type_id, row.key]));
  }
  for (const row of rows)
    row.estimated_group_size = multi.get(canonical([row.type_id, row.pool_id, row.timestamp]))!;
  const edges = new Set<string>();
  for (const snapshot of profile.snapshots) {
    const empty = new Set<string>();
    for (const [path, raw] of Object.entries(snapshot.raw_pages || {})) {
      const match = /^raw\/type_(\d+)\/page_(\d+)\.json$/.exec(path);
      if (!match) continue;
      if (JSON.parse(raw.replace(/^\uFEFF/, '')).data.list.length === 0)
        empty.add(`${Number(match[1])}/${Number(match[2])}`);
    }
    const occurrences = new Map<string, number>();
    const previous = new Map<number, { token: string; key: string; page: number; time: number }>();
    const candidates: { newer: string; older: string; newerKey: string; olderKey: string }[] = [];
    for (const entry of entries(snapshot.document)) {
      const type = entry.source_type_id;
      const page = entry.source_page;
      const raw = entry.record;
      const key = canonical([type, canonical(raw)]);
      const occurrence = increment(occurrences, key);
      const id = token(type, canonical(raw), occurrence);
      const prior = previous.get(type);
      let connected = !!prior && (page === prior.page || page === prior.page + 1);
      if (prior && page > prior.page + 1) {
        // Bound work by the validated number of actual empty pages, even for a malicious page number.
        const distance = page - prior.page - 1;
        connected = distance <= empty.size;
        for (let skipped = prior.page + 1; connected && skipped < page; skipped++)
          connected = empty.has(`${type}/${skipped}`);
      }
      if (prior && connected && prior.time >= Number(raw.time))
        candidates.push({ newer: prior.token, older: id, newerKey: prior.key, olderKey: key });
      previous.set(type, { token: id, key, page, time: Number(raw.time) });
    }
    for (const edge of candidates)
      if (
        occurrences.get(edge.newerKey) === counts.get(edge.newerKey) &&
        occurrences.get(edge.olderKey) === counts.get(edge.olderKey)
      )
        edges.add(canonical([edge.newer, edge.older]));
  }
  const types = new Map<number, Row[]>();
  for (const row of rows) {
    const group = types.get(row.type_id) || [];
    group.push(row);
    types.set(row.type_id, group);
  }
  const launch = profile.endpoint_host?.endsWith('sunborngame.com')
    ? '2024-12-03'
    : profile.endpoint_host?.endsWith('haoplay.com')
      ? '2024-12-05'
      : null;
  for (const group of types.values()) {
    const ordered = [...group].reverse();
    let uncertain = !launch || ordered[0].timestamp.slice(0, 10) !== launch;
    let count = 0;
    let previous: Row | null = null;
    for (const row of ordered) {
      row.gap_before = previous !== null && !edges.has(canonical([row.token, previous.token]));
      uncertain ||= row.gap_before || row.rarity === 'Unknown';
      row.pity = ++count;
      row.pity_uncertain = uncertain;
      if (row.rarity === 'Elite') {
        count = 0;
        uncertain = false;
      }
      previous = row;
    }
  }
  return rows;
}
function publicProfile(profile: PortableProfile): Profile {
  const { snapshots: _snapshots, updated_at: _updated, ...result } = profile;
  return result;
}
export class LocalEngine {
  state: PortableState;
  private cache = new Map<string, Row[]>();
  constructor(state: PortableState = emptyState()) {
    this.state = structuredClone(state);
  }
  private profile(id: string): PortableProfile {
    const profile = this.state.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Profile not found.');
    return profile;
  }
  profiles(): Profile[] {
    return this.state.profiles.map(publicProfile);
  }
  createProfile(name: string): Profile {
    noCredentials(name);
    const timestamp = new Date().toISOString();
    const profile: PortableProfile = {
      id: crypto.randomUUID(),
      name: text(name.trim(), 'profile name', 80),
      account_fingerprint: null,
      endpoint_host: null,
      server: null,
      game_channel_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      snapshots: []
    };
    if (this.state.profiles.length >= 100) throw new Error('At most 100 profiles are supported.');
    this.state.profiles.push(profile);
    return publicProfile(profile);
  }
  renameProfile(id: string, name: string): Profile {
    noCredentials(name);
    const p = this.profile(id);
    p.name = text(name.trim(), 'profile name', 80);
    p.updated_at = new Date().toISOString();
    return publicProfile(p);
  }
  deleteProfile(id: string): void {
    const p = this.profile(id);
    this.state.tombstones = this.state.tombstones.filter((t) => t.profile_id !== id);
    this.state.tombstones.push({
      profile_id: id,
      identity: identityKey(p),
      deleted_at: new Date().toISOString()
    });
    this.state.profiles = this.state.profiles.filter((p) => p.id !== id);
    this.cache.delete(id);
  }
  async importRecords(input: ImportInput): Promise<ImportResult> {
    const { records_document: document, manifest = null, raw_pages = null } = input;
    const id = validateDocument(document, manifest, raw_pages);
    const p = this.profile(input.profile_id);
    const bound = { ...p };
    bind(bound, id);
    const fullIdentity = identityKey(bound);
    if (
      this.state.tombstones.some(
        (t) => t.profile_id === p.id || (fullIdentity !== null && t.identity === fullIdentity)
      )
    )
      throw new Error(
        'This account has a synced deletion. Resolve that deletion before importing it again.'
      );
    if (
      fullIdentity !== null &&
      this.state.profiles.some((other) => other.id !== p.id && identityKey(other) === fullIdentity)
    )
      throw new Error(
        'This game account already belongs to another profile. Select that profile before importing.'
      );
    const hash = await digest([document, manifest, raw_pages]);
    const existing = p.snapshots.find((snapshot) => snapshot.digest === hash);
    const before = this.rows(p.id).length;
    if (existing)
      return {
        id: existing.id,
        profile_id: p.id,
        record_count: (document.records as unknown[]).length,
        added_count: 0,
        complete: (existing.manifest?.complete as boolean) ?? null,
        imported_at: existing.imported_at,
        duplicate: true,
        total: before
      };
    const snapshot: SourceSnapshot = {
      id: crypto.randomUUID(),
      digest: hash,
      document: structuredClone(document),
      manifest: structuredClone(manifest),
      raw_pages: structuredClone(raw_pages),
      imported_at: new Date().toISOString()
    };
    const candidate = {
      ...bound,
      snapshots: [...p.snapshots, snapshot],
      updated_at: snapshot.imported_at
    };
    const totalState = {
      ...this.state,
      profiles: this.state.profiles.map((profile) => (profile.id === p.id ? candidate : profile))
    };
    if (new TextEncoder().encode(canonical(totalState)).length > MAX_STATE_BYTES)
      throw new Error(
        'Local archive exceeds the 64 MiB limit. Export and remove an old profile first.'
      );
    this.state = totalState;
    this.cache.delete(p.id);
    const after = this.rows(p.id).length;
    return {
      id: snapshot.id,
      profile_id: p.id,
      record_count: (document.records as unknown[]).length,
      added_count: after - before,
      complete: (manifest?.complete as boolean) ?? null,
      imported_at: snapshot.imported_at,
      duplicate: false,
      total: after
    };
  }
  private rows(id: string): Row[] {
    if (!this.cache.has(id)) this.cache.set(id, buildRows(this.profile(id)));
    return this.cache.get(id)!;
  }
  private filtered(filters: Partial<Filters> & { profile_id: string }): Row[] {
    return this.rows(filters.profile_id).filter((row) => {
      if (
        filters.q &&
        !`${row.name} ${row.item_id}`.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())
      )
        return false;
      for (const key of ['rarity', 'kind', 'type_id', 'pool_id'] as const) {
        const selected = filters[key];
        if (selected === undefined || selected === '') continue;
        const values = Array.isArray(selected) ? selected : [selected];
        if (
          !values.some((value) =>
            key === 'type_id' || key === 'pool_id'
              ? value !== '' && Number(value) === row[key]
              : value === row[key]
          )
        )
          return false;
      }
      return !(
        (filters.date_from && row.timestamp.slice(0, 10) < filters.date_from) ||
        (filters.date_to && row.timestamp.slice(0, 10) > filters.date_to)
      );
    });
  }
  history(filters: Filters): History {
    const rows = this.filtered(filters);
    const size = Math.max(1, Math.min(500, Math.floor(filters.page_size || 50)));
    const page = Math.max(1, Math.floor(filters.page || 1));
    return {
      items: rows
        .slice((page - 1) * size, page * size)
        .map(({ key: _key, occurrence: _occurrence, token: _token, ...row }) => row),
      total: rows.length,
      page,
      page_size: size,
      pages: Math.max(1, Math.ceil(rows.length / size))
    };
  }
  overview(id: string): Pull[] {
    return this.rows(id).map(
      ({ key: _key, occurrence: _occurrence, token: _token, ...row }) => row
    );
  }
  filterOptions(id: string): FilterOptions {
    const rows = this.rows(id);
    return {
      rarities: [...new Set(rows.map((r) => r.rarity))].sort(),
      kinds: [...new Set(rows.map((r) => r.kind))].sort(),
      types: [...new Set(rows.map((r) => r.type_id))].sort((a, b) => a - b),
      pools: [...new Set(rows.map((r) => r.pool_id))].sort((a, b) => a - b)
    };
  }
  statistics(filters: Filters): Statistics {
    const rows = this.filtered(filters);
    const known = rows.filter((r) => ['doll', 'weapon'].includes(r.kind));
    const profile = this.profile(filters.profile_id);
    const latest = [...profile.snapshots].sort((a, b) =>
      b.imported_at.localeCompare(a.imported_at)
    )[0];
    const labels = (key: 'rarity' | 'kind', source: Row[]) =>
      [
        ...source.reduce(
          (map, r) => map.set(r[key], (map.get(r[key]) || 0) + 1),
          new Map<string, number>()
        )
      ]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, count]) => ({ label, count }));
    const ids = (key: 'type_id' | 'pool_id') =>
      [
        ...rows.reduce(
          (map, r) => map.set(r[key], (map.get(r[key]) || 0) + 1),
          new Map<number, number>()
        )
      ]
        .sort(([a], [b]) => a - b)
        .map(([id, count]) => ({ id, count }));
    const groups = new Map<string, number>();
    for (const row of rows) increment(groups, canonical([row.type_id, row.pool_id, row.timestamp]));
    return {
      total: rows.length,
      known_total: known.length,
      unknown_total: rows.length - known.length,
      rarities: labels('rarity', known),
      kinds: labels('kind', rows),
      types: ids('type_id'),
      pools: ids('pool_id'),
      date_from: rows.at(-1)?.timestamp || null,
      date_to: rows[0]?.timestamp || null,
      last_import_at: latest?.imported_at || null,
      latest_import_complete: (latest?.manifest?.complete as boolean) ?? null,
      coverage: 'accessible_history_only',
      estimated_multi_groups: [...groups.values()].filter((n) => n > 1).length
    };
  }
  exportState(): PortableState {
    return structuredClone(this.state);
  }
  async replaceState(state: unknown): Promise<PortableState> {
    this.state = await validateState(state);
    this.cache.clear();
    return this.exportState();
  }
  async mergeState(input: unknown): Promise<PortableState> {
    const incoming = await validateState(input);
    const merged = this.exportState();
    for (const deletion of incoming.tombstones) {
      if (
        merged.profiles.some(
          (p) =>
            p.id === deletion.profile_id ||
            (deletion.identity !== null && identityKey(p) === deletion.identity)
        )
      )
        throw new Error(
          'A synced deletion conflicts with a local profile. Resolve it in Backup & Sync.'
        );
      if (!merged.tombstones.some((t) => canonical(t) === canonical(deletion)))
        merged.tombstones.push(deletion);
    }
    for (const remote of incoming.profiles) {
      const fullIdentity = identityKey(remote);
      if (
        merged.tombstones.some(
          (t) =>
            t.profile_id === remote.id || (fullIdentity !== null && t.identity === fullIdentity)
        )
      )
        throw new Error(
          'An imported profile conflicts with a deletion. Resolve it in Backup & Sync.'
        );
      const local = merged.profiles.find(
        (p) => p.id === remote.id || (fullIdentity !== null && identityKey(p) === fullIdentity)
      );
      if (!local) {
        merged.profiles.push(remote);
        continue;
      }
      bind(local, remote);
      if (local.name !== remote.name)
        throw new Error('Profile names conflict. Resolve the rename in Backup & Sync.');
      const known = new Set(local.snapshots.map((s) => s.digest));
      local.snapshots.push(...remote.snapshots.filter((s) => !known.has(s.digest)));
      local.snapshots.sort(
        (a, b) => a.imported_at.localeCompare(b.imported_at) || a.digest.localeCompare(b.digest)
      );
      local.updated_at = [local.updated_at, remote.updated_at].sort().at(-1)!;
    }
    // Server-consent settings are intentionally device-local and never restored.
    merged.settings = { ...incoming.settings, ...merged.settings };
    return this.replaceState(merged);
  }
  preferences(): Record<string, string | number | boolean> {
    return { ...this.state.settings };
  }
  setPreferences(settings: Record<string, string | number | boolean>): void {
    const merged = { ...this.state.settings, ...settings };
    validateSettings(merged);
    this.state.settings = merged;
  }
}
function validateSettings(
  value: unknown
): asserts value is Record<string, string | number | boolean> {
  const settings = object(value, 'portable settings');
  noCredentials(settings);
  if (Object.keys(settings).length > 50) throw new Error('Too many portable settings.');
  for (const [key, value] of Object.entries(settings)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) ||
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && value.length > 2000)
    )
      throw new Error('Invalid portable setting.');
    if (/backup|contribut|consent|analytic/i.test(key))
      throw new Error('Server consent preferences must remain on this device.');
  }
}
export async function validateState(input: unknown): Promise<PortableState> {
  const state = object(input, 'archive');
  noCredentials(state);
  if (state.format !== 'gfl2-pull-tracker' || state.version !== 1)
    throw new Error('Unsupported backup format or version.');
  if (new TextEncoder().encode(canonical(state)).length > MAX_STATE_BYTES)
    throw new Error('Archive exceeds the 64 MiB expanded limit.');
  if (
    !Array.isArray(state.profiles) ||
    state.profiles.length > 100 ||
    !Array.isArray(state.tombstones) ||
    state.tombstones.length > 10000
  )
    throw new Error('Invalid profile or deletion list.');
  validateSettings(state.settings);
  const result = emptyState();
  result.settings = { ...state.settings };
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const raw of state.profiles) {
    const p = object(raw, 'profile');
    const id = text(p.id, 'profile ID');
    if (ids.has(id)) throw new Error('Duplicate profile ID.');
    ids.add(id);
    const bound = identity(p);
    if (!Array.isArray(p.snapshots) || p.snapshots.length > 10000)
      throw new Error('Invalid source snapshot list.');
    const profile: PortableProfile = {
      id,
      name: text(p.name, 'profile name', 80),
      ...bound,
      created_at: date(p.created_at, 'profile creation date'),
      updated_at: date(p.updated_at, 'profile modification date'),
      snapshots: []
    };
    const digests = new Set<string>();
    for (const rawSnapshot of p.snapshots) {
      const snapshot = object(rawSnapshot, 'snapshot');
      const document = object(snapshot.document, 'records document');
      const manifest = snapshot.manifest === null ? null : object(snapshot.manifest, 'manifest');
      const rawPages =
        snapshot.raw_pages === null
          ? null
          : (object(snapshot.raw_pages, 'raw pages') as Record<string, string>);
      const sourceIdentity = validateDocument(document, manifest, rawPages);
      bind(profile, sourceIdentity);
      const hash = await digest([document, manifest, rawPages]);
      if (hash !== snapshot.digest) throw new Error('Source snapshot integrity check failed.');
      if (digests.has(hash)) continue;
      digests.add(hash);
      profile.snapshots.push({
        id: text(snapshot.id, 'snapshot ID'),
        digest: hash,
        document: structuredClone(document),
        manifest: structuredClone(manifest),
        raw_pages: structuredClone(rawPages),
        imported_at: date(snapshot.imported_at, 'import date')
      });
    }
    const fullIdentity = identityKey(profile);
    if (fullIdentity !== null && identities.has(fullIdentity))
      throw new Error(
        'Archive repeats a complete game identity across profiles. Merge those profiles before restoring.'
      );
    if (fullIdentity !== null) identities.add(fullIdentity);
    result.profiles.push(profile);
  }
  for (const raw of state.tombstones) {
    const d = object(raw, 'deletion');
    const id = text(d.profile_id, 'deleted profile ID');
    if (ids.has(id)) throw new Error('Archive contains both a profile and its deletion.');
    const value = d.identity === null ? null : text(d.identity, 'deleted identity', 1000);
    if (value !== null) {
      const parsed = JSON.parse(value);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 4 ||
        identityKey(
          identity(
            Object.fromEntries(IDENTITY_FIELDS.map((field, index) => [field, parsed[index]]))
          )
        ) !== value
      )
        throw new Error('Invalid deleted identity.');
    }
    if (value !== null && result.profiles.some((p) => identityKey(p) === value))
      throw new Error('Archive contains both a game identity and its deletion.');
    result.tombstones.push({
      profile_id: id,
      identity: value,
      deleted_at: date(d.deleted_at, 'deletion date')
    });
  }
  return result;
}
