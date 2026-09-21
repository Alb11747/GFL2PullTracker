<script lang="ts">
  import EliteHistory from '../../src/lib/components/EliteHistory.svelte';
  import type { Pull } from '../../src/lib/api';

  export let rows: Pull[];
  let profileId = 'synthetic-profile-a';
  export function changeProfile() {
    profileId = profileId === 'synthetic-profile-a' ? 'synthetic-profile-b' : 'synthetic-profile-a';
  }
  export function replaceRows(next: Pull[]) {
    rows = next;
  }
</script>

<EliteHistory {rows} {profileId} />
