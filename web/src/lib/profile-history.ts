import type { Filters, Pull } from './api';

export function profileFilters(profile_id: string): Filters {
  return {
    profile_id,
    q: '',
    rarity: '',
    kind: '',
    type_id: '',
    pool_id: '',
    date_from: '',
    date_to: '',
    page: 1,
    page_size: 200
  };
}

/** Cache a single profile revision so log filtering never refetches the full archive. */
export function createProfileHistoryLoader(read: (profileId: string) => Promise<Pull[]>) {
  let cachedKey = '';
  let cached: Promise<Pull[]> | undefined;
  const load = (profileId: string, revision: string): Promise<Pull[]> => {
    const key = JSON.stringify([profileId, revision]);
    if (key === cachedKey && cached) return cached;
    cachedKey = key;
    const task = read(profileId);
    cached = task;
    void task.catch(() => {
      if (cached === task) cached = undefined;
    });
    return task;
  };
  return Object.assign(load, {
    invalidate() {
      cachedKey = '';
      cached = undefined;
    }
  });
}
