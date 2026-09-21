import type { Pull } from './api.ts';

/** Keeps API pity intact; only complete Elite intervals contribute to the average. */
export function eliteSummary(rows: Pull[], type: number | null) {
  const scoped = rows
    .filter((row) => row.type_id === type)
    .sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) ||
        a.timestamp_order - b.timestamp_order ||
        a.id - b.id
    );
  const elites = scoped.filter((row) => row.rarity === 'Elite');
  const latest = scoped[0];
  const known = elites.filter((row) => !row.pity_uncertain);
  return {
    scoped,
    elites,
    currentPity: latest?.rarity === 'Elite' ? 0 : (latest?.pity ?? 0),
    currentUncertain: latest?.rarity !== 'Elite' && !!latest?.pity_uncertain,
    average: known.length
      ? (known.reduce((sum, row) => sum + row.pity, 0) / known.length).toFixed(1)
      : '—'
  };
}
