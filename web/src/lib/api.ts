export interface Profile {
  id: string;
  name: string;
  account_fingerprint: string | null;
  endpoint_host: string | null;
  server: string | null;
  game_channel_id: string | null;
  created_at: string;
}
export interface Pull {
  id: number;
  item_id: number;
  name: string;
  kind: string;
  rarity: string;
  region: string | null;
  type_id: number;
  pool_id: number;
  timestamp: string;
  quantity: number;
  source_page: number;
  estimated_group_size: number;
}
export interface Filters {
  profile_id: string;
  q: string;
  rarity: string;
  kind: string;
  type_id: string;
  pool_id: string;
  date_from: string;
  date_to: string;
  page: number;
  page_size: number;
}
export interface History {
  items: Pull[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}
export interface Statistics {
  total: number;
  known_total: number;
  unknown_total: number;
  rarities: { label: string; count: number }[];
  kinds: { label: string; count: number }[];
  types: { id: number; count: number }[];
  pools: { id: number; count: number }[];
  date_from: string | null;
  date_to: string | null;
  last_import_at: string | null;
  latest_import_complete: boolean | null;
  coverage: 'accessible_history_only';
  estimated_multi_groups: number;
}
export interface ImportResult {
  id: string;
  profile_id: string;
  record_count: number;
  added_count: number;
  complete: boolean | null;
  imported_at: string;
  duplicate: boolean;
  total: number;
}
export interface Job {
  id: string;
  profile_id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'interrupted';
  message: string;
  records: number;
  pages: number;
  type_id: number | null;
  import_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface FilterOptions {
  rarities: string[];
  kinds: string[];
  types: number[];
  pools: number[];
}
export interface ImportInput {
  profile_id: string;
  records_document: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  raw_pages?: Record<string, string>;
}

/** Empty numeric/date filters must be omitted rather than sent as invalid empty values. */
export function queryString(filters: Partial<Filters>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== '' && value !== undefined) query.set(key, String(value));
  return query.toString();
}
export function createClient(fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      // A disconnected mutation may have completed, so never automatically retry it.
      response = await fetcher(
        `/api/${path}`,
        body === undefined
          ? { cache: 'no-store' }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            }
      );
    } catch {
      throw new Error(
        body === undefined
          ? 'The local tracker is unavailable. Check that both services are running.'
          : 'The connection ended before the result was confirmed. Check the archive before submitting again. Fetching requires a fresh capture.'
      );
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        typeof data?.detail === 'string'
          ? data.detail
          : 'The local tracker could not complete this request.'
      );
    if (data === null) throw new Error('The local tracker returned an unreadable response.');
    return data as T;
  }
  return {
    async profiles() {
      return (await request<{ profiles: Profile[] }>('profiles')).profiles;
    },
    createProfile(name: string) {
      return request<Profile>('profiles', { name });
    },
    history(filters: Filters) {
      return request<History>(`history?${queryString(filters)}`);
    },
    statistics(filters: Filters) {
      const { page: _page, page_size: _size, ...selection } = filters;
      return request<Statistics>(`statistics?${queryString(selection)}`);
    },
    filterOptions(profile_id: string) {
      return request<FilterOptions>(`filters?${queryString({ profile_id })}`);
    },
    importRecords(input: ImportInput) {
      return request<ImportResult>('imports', input);
    },
    fetchHistory(profile_id: string, capture: string, server?: string) {
      return request<Job>('fetch', { profile_id, capture, ...(server ? { server } : {}) });
    },
    job(id: string) {
      return request<Job>(`jobs/${encodeURIComponent(id)}`);
    }
  };
}
export const client = createClient();
