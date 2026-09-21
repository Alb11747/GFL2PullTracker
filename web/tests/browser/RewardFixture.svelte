<script lang="ts">
  import EliteHistory from '../../src/lib/components/EliteHistory.svelte';
  import type { Pull } from '../../src/lib/api';
  import { createRewardQuery, type ProfileOverview } from '../../src/lib/reward-query';

  export let rows: Pull[];
  let profileId = 'synthetic-profile-a';
  let revision = 0;
  let deferred = false;
  let waiting: {
    resolve: (value: ProfileOverview) => void;
    reject: (error: Error) => void;
    result: ProfileOverview;
  }[] = [];
  export const requests: { profileId: string; offset: number; limit: number }[] = [];
  $: rewardQuery = createRewardQuery(rows);

  function query(
    profile: string,
    type: number | null,
    rarities: string[],
    offset: number,
    limit: number
  ) {
    requests.push({ profileId: profile, offset, limit });
    const result = rewardQuery(type, rarities, offset, limit);
    if (!deferred) return Promise.resolve(result);
    return new Promise<ProfileOverview>((resolve, reject) =>
      waiting.push({ resolve, reject, result })
    );
  }
  export function deferQueries(value = true) {
    deferred = value;
  }
  export function pendingCount() {
    return waiting.length;
  }
  export function finishQuery(index = 0, error = '') {
    const [request] = waiting.splice(index, 1);
    if (error) request.reject(new Error(error));
    else request.resolve(request.result);
  }
  export function changeProfile() {
    profileId = profileId === 'synthetic-profile-a' ? 'synthetic-profile-b' : 'synthetic-profile-a';
  }
  export function replaceRows(next: Pull[]) {
    rows = next;
    revision++;
  }
</script>

<EliteHistory {query} {revision} {profileId} />
