type JsonObject = Record<string, unknown>;
export interface ExiliumProfile {
  id: string;
  name: string;
}
const LIMIT = 64 * 1024 * 1024;
const secretKey =
  /^(authorization|cookie|token|capture|account_value|original_url|headers|access_token|refresh_token|id_token|session|session_id|csrf|csrf_token|verified|verified_at|server_verified|verification|trusted|__proto__|constructor|prototype)$/i;

/** Check retained metadata as well as the records that will be normalized. */
export function validateImportContents(value: unknown, depth = 0): void {
  if (depth > 50) throw new Error('Import is nested too deeply.');
  if (
    typeof value === 'string' &&
    (/\bBearer\s+[A-Za-z0-9._~-]{8,}/i.test(value) ||
      /[?&](?:token|access_token|auth|authorization|cookie)=/i.test(value))
  )
    throw new Error('Import contains credentials. Select an export without request captures.');
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (secretKey.test(key))
        throw new Error('Import contains credentials or server verification claims.');
      validateImportContents(child, depth + 1);
    }
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Exilium backup object.');
  return value as JsonObject;
}
function base64(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > LIMIT ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error('Invalid Exilium base64 data.');
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function unzip(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const reader = new Blob([value])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) throw new Error('Exilium backup exceeds the 64 MiB expanded limit.');
      chunks.push(value);
    }
    return await new Blob(chunks).text();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Exilium settings export v2: base64(gzip(JSON.stringify(JSON.stringify(
 * base64(gzip(Zustand JSON)))))). This is the observed settings export and
 * OPFS adapter protocol; legacy Dexie v0/v1 backup envelopes are not this format.
 */
export async function decodeExilium(value: JsonObject): Promise<JsonObject | null> {
  validateImportContents(value);
  if ('schema_version' in value) return null;
  let store: JsonObject;
  if ('data' in value || 'compressed' in value) {
    if (value.version !== 2 || value.compressed !== true)
      throw new Error(
        'Unsupported Exilium backup version. Supported: compressed settings export v2 and recovered data-store v1.'
      );
    if (
      typeof value.timestamp !== 'number' ||
      !Number.isSafeInteger(value.timestamp) ||
      value.timestamp < 0
    )
      throw new Error('Invalid Exilium backup timestamp.');
    try {
      const serialized: unknown = JSON.parse(await unzip(base64(value.data)));
      if (typeof serialized !== 'string') throw new Error('Invalid Exilium storage encoding.');
      const inner: unknown = JSON.parse(serialized);
      store = object(JSON.parse(await unzip(base64(inner))));
    } catch (error) {
      if (error instanceof Error && /64 MiB/.test(error.message)) throw error;
      throw new Error('Invalid or damaged Exilium v2 compressed backup.');
    }
  } else if ('state' in value && 'version' in value) store = value;
  else return null;
  if (store.version !== 1) throw new Error('Unsupported Exilium data-store version; expected 1.');
  validateImportContents(store);
  object(object(store.state).profilesData);
  return store;
}

export function exiliumProfiles(store: JsonObject): ExiliumProfile[] {
  return Object.entries(object(object(store.state).profilesData)).map(([id, input]) => {
    const profile = object(object(input).profile);
    if (
      !id ||
      profile.id !== id ||
      typeof profile.name !== 'string' ||
      !profile.name.trim() ||
      profile.name.length > 200
    )
      throw new Error('Invalid Exilium profile metadata.');
    return { id, name: profile.name };
  });
}

export function convertExilium(store: JsonObject, sourceId?: string): JsonObject {
  const profiles = exiliumProfiles(store);
  if (!sourceId && profiles.length === 1) sourceId = profiles[0].id;
  if (!sourceId) throw new Error('Select an Exilium source profile before importing this backup.');
  if (!profiles.some((profile) => profile.id === sourceId))
    throw new Error('The selected Exilium source profile is not in this backup.');
  const source = object(object(object(store.state).profilesData)[sourceId]);
  const records: JsonObject[] = [];
  const identities = new Set<string>();
  for (const [type, input] of Object.entries(object(source.pulls))) {
    if (!/^[1-9]\d*$/.test(type) || !Number.isSafeInteger(Number(type)) || !Array.isArray(input))
      throw new Error('Invalid Exilium source type or pulls.');
    let previous = -1;
    for (const inputRow of input) {
      const row = object(inputRow);
      for (const key of ['pool_id', 'item', 'time', 'type_id'])
        if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)
          throw new Error('Invalid Exilium pull record.');
      if (
        row.type_id !== Number(type) ||
        Number(row.time) < previous ||
        Number(row.time) > 253402300799
      )
        throw new Error('Exilium pulls must retain their oldest-first source order.');
      if (typeof row.uid !== 'string' || !row.uid || typeof row.server !== 'string' || !row.server)
        throw new Error('Exilium pull lacks an account or server identity.');
      identities.add(JSON.stringify([row.uid, row.server]));
      if (identities.size > 1)
        throw new Error(
          'The Exilium source profile contains multiple accounts or servers. Separate them before importing.'
        );
      previous = Number(row.time);
      if ('item_num' in row && row.item_num !== 1)
        throw new Error('Unsupported Exilium quantity; each exported row must represent one pull.');
      records.push({
        source_type_id: Number(type),
        source_page: 1,
        record: { pool_id: row.pool_id, item: row.item, time: row.time, item_num: 1 }
      });
      if (records.length > 500_000)
        throw new Error('Export records must contain at most 500,000 records.');
    }
  }
  // Exilium lacks the official host/server/channel tuple. Its UID cannot safely
  // be substituted for the collector's opaque account query value.
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    records,
    external_source: {
      source: 'https://exilium.xyz',
      storage: 'data-store-v1',
      profile_assignment: 'explicit',
      quantity_note:
        'Each stored row represents one pull; original response quantity is unavailable.',
      recovered_store: { version: 1, state: { profilesData: { [sourceId]: source } } }
    }
  };
}
