import type { Pull } from './api.ts';
import { rewardRarities, rewardRarity } from './reward-history.ts';

/** Summary facts describe the entire recruitment; total/items apply the rarity selection. */
export interface ProfileOverview {
  types: number[];
  selectedType: number | null;
  currentPity: number;
  currentUncertain: boolean;
  average: number | null;
  lastElite: Pull | null;
  breakdown: { rarity: string; count: number; percent: number }[];
  availableRarities: string[];
  total: number;
  items: Pull[];
}

/** Build once for immutable profile rows, so reward paging never sorts history again. */
export function createRewardQuery(rows: Pull[]) {
  const groups = new Map<number, Pull[]>();
  for (const row of rows) {
    if (!groups.has(row.type_id)) groups.set(row.type_id, []);
    groups.get(row.type_id)!.push(row);
  }
  const types = [...groups.keys()].sort((a, b) => a - b);
  const summaries = new Map<
    number,
    Omit<ProfileOverview, 'types' | 'selectedType' | 'availableRarities' | 'total' | 'items'>
  >();
  for (const [type, scoped] of groups) {
    scoped.sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) ||
        a.timestamp_order - b.timestamp_order ||
        a.id - b.id
    );
    const counts = new Map<string, number>();
    let knownCount = 0;
    let knownPity = 0;
    let lastElite: Pull | null = null;
    for (const row of scoped) {
      const rarity = rewardRarity(row.rarity);
      counts.set(rarity, (counts.get(rarity) ?? 0) + 1);
      if (row.rarity === 'Elite') {
        lastElite ??= row;
        if (!row.pity_uncertain) {
          knownCount++;
          knownPity += row.pity;
        }
      }
    }
    const latest = scoped[0];
    summaries.set(type, {
      currentPity: latest.rarity === 'Elite' ? 0 : latest.pity,
      currentUncertain: latest.rarity !== 'Elite' && latest.pity_uncertain,
      average: knownCount ? knownPity / knownCount : null,
      lastElite,
      breakdown: rewardRarities
        .map(({ key }) => ({
          rarity: key,
          count: counts.get(key) ?? 0,
          percent: ((counts.get(key) ?? 0) / scoped.length) * 100
        }))
        .filter(({ rarity, count }) => rarity !== 'Unknown' || count > 0)
    });
  }
  return (
    typeId: number | null,
    rarities: string[],
    offset: number,
    limit: number
  ): ProfileOverview => {
    const selectedType =
      typeId !== null && groups.has(typeId) ? typeId : types.includes(3) ? 3 : (types[0] ?? null);
    const summary =
      selectedType === null
        ? {
            currentPity: 0,
            currentUncertain: false,
            average: null,
            lastElite: null,
            breakdown: rewardRarities
              .filter(({ key }) => key !== 'Unknown')
              .map(({ key }) => ({ rarity: key, count: 0, percent: 0 }))
          }
        : summaries.get(selectedType)!;
    const selected = new Set(rarities);
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 20;
    const scoped = selectedType === null ? [] : groups.get(selectedType)!;
    // Recruitment summaries already counted each rarity when this immutable
    // query was built. Paging must not repeat a full-history count.
    const total = summary.breakdown.reduce(
      (sum, entry) => sum + (selected.has(entry.rarity) ? entry.count : 0),
      0
    );
    let items: Pull[] = [];
    if (start < total) {
      if (total === scoped.length) items = scoped.slice(start, start + count);
      else {
        let matched = 0;
        for (const row of scoped) {
          if (!selected.has(rewardRarity(row.rarity))) continue;
          if (matched++ >= start) items.push(row);
          if (items.length === count) break;
        }
      }
    }
    return {
      ...summary,
      types,
      selectedType,
      availableRarities: rewardRarities
        .filter(
          ({ key }) =>
            key !== 'Unknown' ||
            selected.has(key) ||
            summary.breakdown.some((entry) => entry.rarity === 'Unknown')
        )
        .map(({ key }) => key),
      total,
      items
    };
  };
}
