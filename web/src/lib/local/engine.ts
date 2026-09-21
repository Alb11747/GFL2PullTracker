import catalog from '../../../../backend/catalog.json' with { type: 'json' };
import { createRewardQuery, type ProfileOverview } from '../reward-query.ts';
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
  requireArchiveVersion,
  IDENTITY_FIELDS,
  identityKey,
  profileIds,
  deletionIds,
  MAX_PROFILE_ALIASES,
  OFFICIAL_HOSTS,
  type Identity,
  type PortableProfile,
  type PortableState,
  type SourceSnapshot
} from './types.ts';

/** Explicitly rejected archive content, distinct from storage or platform failures. */
export class InvalidArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
  }
}

export const MAX_STATE_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDS = 500_000;
const items = new Map(catalog.items.map((item) => [item.id, item]));
/** Worker diagnostics count actual reconstruction, without including personal data. */
export const engineDiagnostics = { engineBuilds: 0, rowBuilds: 0 };
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
    throw new InvalidArchiveError(`Invalid ${label}.`);
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
  if (depth > 50) throw new InvalidArchiveError('Archive is nested too deeply.');
  if (
    typeof value === 'string' &&
    (/\bBearer\s+[A-Za-z0-9._~-]{8,}/i.test(value) ||
      /[?&](?:token|access_token|auth|authorization|cookie)=/i.test(value))
  )
    throw new InvalidArchiveError(
      'Archive contains credentials. Export records without request captures.'
    );
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (blocked.test(key))
        throw new InvalidArchiveError(
          'Archive contains credentials or server verification claims.'
        );
      noCredentials(child, depth + 1);
    }
  }
}
function integer(value: unknown, label: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new InvalidArchiveError(`Invalid ${label}.`);
  return value;
}
function date(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new InvalidArchiveError(`Invalid ${label}; use an ISO timestamp with timezone.`);
  return value;
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new InvalidArchiveError(`Invalid ${label}.`);
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
    throw new InvalidArchiveError('Invalid account fingerprint.');
  if (result.endpoint_host !== null && !OFFICIAL_HOSTS.has(result.endpoint_host))
    throw new InvalidArchiveError('Unknown game endpoint host.');
  for (const key of ['server', 'game_channel_id'] as const)
    if (result[key] !== null && !/^\d+$/.test(result[key]))
      throw new InvalidArchiveError('Invalid server or channel.');
  return result;
}
function bind(profile: Identity, incoming: Identity): void {
  for (const key of IDENTITY_FIELDS) {
    if (profile[key] !== null && incoming[key] !== null && incoming[key] !== profile[key])
      throw new InvalidArchiveError(
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
    throw new InvalidArchiveError('Unsupported export schema version; expected 1 or 2.');
  date(document.exported_at, 'export date');
  if (!Array.isArray(document.records) || document.records.length > MAX_RECORDS)
    throw new InvalidArchiveError('Export records must contain at most 500,000 records.');
  const id = identity(document);
  // Legacy records can be deliberately assigned to a selected profile. They may
  // remain unbound, but can never independently match a different synced profile.
  if (document.schema_version === 2 && IDENTITY_FIELDS.some((key) => id[key] === null))
    throw new InvalidArchiveError('Version 2 exports need a complete collector identity.');
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
      throw new InvalidArchiveError('Invalid timestamp.');
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
      throw new InvalidArchiveError('Invalid manifest schema or collection status.');
    date(manifest.started_at, 'manifest start date');
    if (manifest.completed_at != null) date(manifest.completed_at, 'manifest completion date');
    if (manifest.complete && manifest.completed_at == null)
      throw new InvalidArchiveError('Completed manifest needs a completion date.');
    if (manifest.started_at !== document.exported_at)
      throw new InvalidArchiveError('Manifest and records belong to different runs.');
    for (const key of IDENTITY_FIELDS)
      if (manifest[key] != null && manifest[key] !== id[key])
        throw new InvalidArchiveError('Manifest identity does not match the records.');
    const types = object(manifest.types, 'manifest types');
    for (const [key, input] of Object.entries(types)) {
      const value = object(input, 'manifest type');
      if (
        !/^[1-9][0-9]{0,18}$/.test(key) ||
        !['complete', 'empty', 'unavailable', 'in_progress', 'error'].includes(
          value.status as string
        )
      )
        throw new InvalidArchiveError('Invalid manifest type status.');
      integer(value.pages, 'manifest pages', true);
      integer(value.records, 'manifest records', true);
      if (value.records !== (counts.get(Number(key)) || 0))
        throw new InvalidArchiveError('Manifest counts do not match the records.');
      if (
        manifest.complete &&
        !['complete', 'empty', 'unavailable'].includes(value.status as string)
      )
        throw new InvalidArchiveError('Completed manifest contains an unfinished type.');
    }
    for (const row of document.records as Entry[]) {
      const status = types[String(row.source_type_id)] as JsonObject | undefined;
      if (!status || row.source_page > Number(status.pages))
        throw new InvalidArchiveError('Record provenance exceeds manifest pages.');
    }
  }
  if (rawPages !== null) {
    const seen = new Set<string>();
    for (const [path, contents] of Object.entries(rawPages)) {
      const match = /^(?:raw|responses)\/type_(\d+)\/page_(\d+)\.json$/.exec(path);
      if (!match || typeof contents !== 'string')
        throw new InvalidArchiveError('Invalid raw page archive name or content.');
      let parsed: JsonObject;
      try {
        parsed = object(JSON.parse(contents.replace(/^\uFEFF/, '')), 'raw page');
      } catch (cause) {
        if (cause instanceof SyntaxError)
          throw new InvalidArchiveError('Raw page does not contain valid JSON.');
        throw cause;
      }
      noCredentials(parsed);
      const list = object(parsed.data, 'raw page data').list;
      if (!Array.isArray(list))
        throw new InvalidArchiveError('Raw pages must contain response record arrays.');
      // Incremental collectors also preserve original network responses. Those
      // can include overlap stripped from the normalized raw page archive.
      if (path.startsWith('responses/')) continue;
      const key = `${Number(match[1])}/${Number(match[2])}`;
      if (
        !Array.isArray(list) ||
        seen.has(key) ||
        canonical(list) !== canonical(expected.get(key) || [])
      )
        throw new InvalidArchiveError('Raw page records do not match snapshot provenance.');
      seen.add(key);
    }
    if ([...expected.keys()].some((key) => !seen.has(key)))
      throw new InvalidArchiveError('Raw archive is missing referenced pages.');
  }
  if (new TextEncoder().encode(canonical([document, manifest, rawPages])).length > MAX_STATE_BYTES)
    throw new InvalidArchiveError('Import exceeds the 64 MiB expanded limit.');
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
  const { snapshots: _snapshots, updated_at: _updated, aliases: _aliases, ...result } = profile;
  return result;
}
function sameDerivedProfile(left: PortableProfile, right: PortableProfile): boolean {
  // Validated snapshot digests cover documents, manifests and raw pages. Their
  // sequence controls occurrence/order merging; the host controls launch pity.
  return (
    left.id === right.id &&
    left.endpoint_host === right.endpoint_host &&
    left.snapshots.length === right.snapshots.length &&
    left.snapshots.every((snapshot, index) => snapshot.digest === right.snapshots[index].digest)
  );
}
export class LocalEngine {
  state: PortableState;
  private cache = new Map<string, Row[]>();
  private rewardQueries = new Map<string, ReturnType<typeof createRewardQuery>>();
  constructor(state: PortableState = emptyState()) {
    engineDiagnostics.engineBuilds++;
    requireArchiveVersion(state.version);
    this.state = structuredClone(state);
  }
  /** A mutation works on its own state until persistence succeeds. Derived rows are immutable. */
  fork(state: PortableState = this.state): LocalEngine {
    const candidate = new LocalEngine(state);
    candidate.cache = new Map(this.cache);
    candidate.rewardQueries = new Map(this.rewardQueries);
    candidate.retainDerivedCaches(this.state, state);
    return candidate;
  }
  private retainDerivedCaches(previous: PortableState, next: PortableState): void {
    const profiles = new Map(next.profiles.map((profile) => [profile.id, profile]));
    for (const profile of previous.profiles) {
      const replacement = profiles.get(profile.id);
      if (!replacement || !sameDerivedProfile(profile, replacement)) {
        this.cache.delete(profile.id);
        this.rewardQueries.delete(profile.id);
      }
    }
  }
  private profile(id: string): PortableProfile {
    const profile = this.state.profiles.find((p) => profileIds(p).includes(id));
    if (!profile) throw new InvalidArchiveError('Profile not found.');
    return profile;
  }
  profiles(): Profile[] {
    return this.state.profiles.map(publicProfile);
  }
  createProfile(name: string): Profile {
    noCredentials(name);
    const timestamp = new Date().toISOString();
    const id = crypto.randomUUID();
    const profile: PortableProfile = {
      id,
      aliases: [id],
      name: text(name.trim(), 'profile name', 80),
      account_fingerprint: null,
      endpoint_host: null,
      server: null,
      game_channel_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      snapshots: []
    };
    if (this.state.profiles.length >= 100)
      throw new InvalidArchiveError('At most 100 profiles are supported.');
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
    this.state.tombstones = this.state.tombstones.filter(
      (t) => !deletionIds(t).some((alias) => profileIds(p).includes(alias))
    );
    this.state.tombstones.push({
      profile_id: p.id,
      aliases: profileIds(p),
      identity: identityKey(p),
      deleted_at: new Date().toISOString()
    });
    this.state.profiles = this.state.profiles.filter((profile) => profile !== p);
    this.cache.delete(p.id);
    this.rewardQueries.delete(p.id);
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
        (t) =>
          deletionIds(t).some((alias) => profileIds(p).includes(alias)) ||
          (fullIdentity !== null && t.identity === fullIdentity)
      )
    )
      throw new InvalidArchiveError(
        'This account has a synced deletion. Resolve that deletion before importing it again.'
      );
    if (
      fullIdentity !== null &&
      this.state.profiles.some((other) => other.id !== p.id && identityKey(other) === fullIdentity)
    )
      throw new InvalidArchiveError(
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
      throw new InvalidArchiveError(
        'Local archive exceeds the 64 MiB limit. Export and remove an old profile first.'
      );
    this.state = totalState;
    this.cache.delete(p.id);
    this.rewardQueries.delete(p.id);
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
    const profile = this.profile(id);
    if (!this.cache.has(profile.id)) {
      engineDiagnostics.rowBuilds++;
      this.cache.set(profile.id, buildRows(profile));
    }
    return this.cache.get(profile.id)!;
  }
  private filtered(filters: Partial<Filters> & { profile_id: string }): Row[] {
    const query = filters.q?.toLocaleLowerCase();
    const selections = (['rarity', 'kind', 'type_id', 'pool_id'] as const).flatMap((key) => {
      const selected = filters[key];
      if (selected === undefined || selected === '') return [];
      const values = Array.isArray(selected) ? selected : [selected];
      return [
        {
          key,
          values: new Set<string | number>(
            key === 'type_id' || key === 'pool_id'
              ? values.filter((value) => value !== '').map(Number)
              : values
          )
        }
      ];
    });
    return this.rows(filters.profile_id).filter((row) => {
      if (query && !`${row.name} ${row.item_id}`.toLocaleLowerCase().includes(query)) return false;
      for (const { key, values } of selections) if (!values.has(row[key])) return false;
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
  rewards(
    id: string,
    typeId: number | null,
    rarities: string[],
    offset: number,
    limit: number
  ): ProfileOverview {
    const profile = this.profile(id);
    if (!this.rewardQueries.has(profile.id))
      this.rewardQueries.set(profile.id, createRewardQuery(this.rows(profile.id)));
    const result = this.rewardQueries.get(profile.id)!(typeId, rarities, offset, limit);
    const publicRow = ({ key: _key, occurrence: _occurrence, token: _token, ...row }: Row): Pull =>
      row;
    return {
      ...result,
      items: result.items.map((row) => publicRow(row as Row)),
      lastElite: result.lastElite ? publicRow(result.lastElite as Row) : null
    };
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
    const next = await validateState(state);
    this.retainDerivedCaches(this.state, next);
    this.state = next;
    return this.exportState();
  }
  async mergeState(input: unknown): Promise<PortableState> {
    const incoming = await validateState(input);
    const merged = this.exportState();
    for (const deletion of incoming.tombstones) {
      if (
        merged.profiles.some(
          (p) =>
            profileIds(p).some((alias) => deletionIds(deletion).includes(alias)) ||
            (deletion.identity !== null && identityKey(p) === deletion.identity)
        )
      )
        throw new InvalidArchiveError(
          'A synced deletion conflicts with a local profile. Resolve it in Backup & Sync.'
        );
      const existing = merged.tombstones.find(
        (t) =>
          deletionIds(t).some((alias) => deletionIds(deletion).includes(alias)) ||
          (t.identity !== null && t.identity === deletion.identity)
      );
      if (existing) {
        if (
          existing.identity !== null &&
          deletion.identity !== null &&
          existing.identity !== deletion.identity
        )
          throw new InvalidArchiveError('Deletion aliases refer to different game accounts.');
        existing.aliases = [
          ...new Set([...deletionIds(existing), ...deletionIds(deletion)])
        ].sort();
        existing.profile_id = existing.aliases[0];
        existing.identity ??= deletion.identity;
        existing.deleted_at = [existing.deleted_at, deletion.deleted_at].sort().at(-1)!;
      } else merged.tombstones.push(deletion);
    }
    for (const remote of incoming.profiles) {
      const fullIdentity = identityKey(remote);
      if (
        merged.tombstones.some(
          (t) =>
            deletionIds(t).some((alias) => profileIds(remote).includes(alias)) ||
            (fullIdentity !== null && t.identity === fullIdentity)
        )
      )
        throw new InvalidArchiveError(
          'An imported profile conflicts with a deletion. Resolve it in Backup & Sync.'
        );
      const local = merged.profiles.find(
        (p) =>
          profileIds(p).some((alias) => profileIds(remote).includes(alias)) ||
          (fullIdentity !== null && identityKey(p) === fullIdentity)
      );
      if (!local) {
        merged.profiles.push(remote);
        continue;
      }
      bind(local, remote);
      local.aliases = [...new Set([...profileIds(local), ...profileIds(remote)])].sort();
      local.id = local.aliases[0];
      if (local.name !== remote.name)
        throw new InvalidArchiveError(
          'Profile names conflict. Resolve the rename in Backup & Sync.'
        );
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
  if (Object.keys(settings).length > 50)
    throw new InvalidArchiveError('Too many portable settings.');
  for (const [key, value] of Object.entries(settings)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) ||
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && value.length > 2000)
    )
      throw new InvalidArchiveError('Invalid portable setting.');
    if (/backup|contribut|consent|analytic/i.test(key))
      throw new InvalidArchiveError('Server consent preferences must remain on this device.');
  }
}
export async function validateState(input: unknown): Promise<PortableState> {
  const state = object(input, 'archive');
  if (state.format !== 'gfl2-pull-tracker')
    throw new InvalidArchiveError('Unsupported backup format.');
  requireArchiveVersion(state.version);
  noCredentials(state);
  if (new TextEncoder().encode(canonical(state)).length > MAX_STATE_BYTES)
    throw new InvalidArchiveError('Archive exceeds the 64 MiB expanded limit.');
  if (
    !Array.isArray(state.profiles) ||
    state.profiles.length > 100 ||
    !Array.isArray(state.tombstones) ||
    state.tombstones.length > 10000
  )
    throw new InvalidArchiveError('Invalid profile or deletion list.');
  validateSettings(state.settings);
  const result = emptyState();
  result.settings = { ...state.settings };
  const ids = new Set<string>();
  const identities = new Set<string>();
  let aliasReferences = 0;
  function aliases(value: unknown, id: string): string[] {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PROFILE_ALIASES)
      throw new InvalidArchiveError('Invalid profile aliases.');
    const validated = value.map((alias) => text(alias, 'profile alias'));
    if (
      new Set(validated).size !== validated.length ||
      !validated.includes(id) ||
      canonical(validated) !== canonical([...validated].sort())
    )
      throw new InvalidArchiveError(
        'Profile aliases must be unique, sorted, and include the canonical ID.'
      );
    aliasReferences += validated.length;
    if (aliasReferences > MAX_PROFILE_ALIASES)
      throw new InvalidArchiveError('Archive contains too many profile alias references.');
    return validated;
  }
  for (const raw of state.profiles) {
    const p = object(raw, 'profile');
    const id = text(p.id, 'profile ID');
    const retainedIds = aliases(p.aliases, id);
    if (retainedIds.some((alias) => ids.has(alias)))
      throw new InvalidArchiveError('Duplicate profile ID or alias.');
    retainedIds.forEach((alias) => ids.add(alias));
    const bound = identity(p);
    if (!Array.isArray(p.snapshots) || p.snapshots.length > 10000)
      throw new InvalidArchiveError('Invalid source snapshot list.');
    const profile: PortableProfile = {
      id,
      aliases: retainedIds,
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
      if (hash !== snapshot.digest)
        throw new InvalidArchiveError('Source snapshot integrity check failed.');
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
      throw new InvalidArchiveError(
        'Archive repeats a complete game identity across profiles. Merge those profiles before restoring.'
      );
    if (fullIdentity !== null) identities.add(fullIdentity);
    result.profiles.push(profile);
  }
  const deletionOwners = new Map<string, string | null>();
  for (const raw of state.tombstones) {
    const d = object(raw, 'deletion');
    const id = text(d.profile_id, 'deleted profile ID');
    const retainedIds = aliases(d.aliases, id);
    if (retainedIds.some((alias) => ids.has(alias)))
      throw new InvalidArchiveError('Archive contains both a profile and its deletion.');
    const value = d.identity === null ? null : text(d.identity, 'deleted identity', 1000);
    if (value !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new InvalidArchiveError('Invalid deleted identity.');
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 4 ||
        identityKey(
          identity(
            Object.fromEntries(IDENTITY_FIELDS.map((field, index) => [field, parsed[index]]))
          )
        ) !== value
      )
        throw new InvalidArchiveError('Invalid deleted identity.');
    }
    if (value !== null && result.profiles.some((p) => identityKey(p) === value))
      throw new InvalidArchiveError('Archive contains both a game identity and its deletion.');
    if (retainedIds.some((alias) => deletionOwners.has(alias)))
      throw new InvalidArchiveError('Archive repeats a deletion alias.');
    retainedIds.forEach((alias) => deletionOwners.set(alias, value));
    result.tombstones.push({
      profile_id: id,
      aliases: retainedIds,
      identity: value,
      deleted_at: date(d.deleted_at, 'deletion date')
    });
  }
  return result;
}
