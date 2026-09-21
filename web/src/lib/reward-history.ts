import type { Pull } from './api.ts';

export const REWARD_RARITIES_KEY = 'gfl2.reward-rarities';
export const rewardRarities = [
  { key: 'Elite', label: '5★', name: 'Elite' },
  { key: 'Standard', label: '4★', name: 'Standard' },
  { key: 'Retired', label: '3★', name: 'Retired' },
  { key: 'Unknown', label: 'Unknown', name: 'Unknown' }
] as const;
export type RewardRarity = (typeof rewardRarities)[number]['key'];

export function rewardRarity(value: string): RewardRarity {
  return rewardRarities.find((rarity) => rarity.key === value)?.key ?? 'Unknown';
}

export function readRewardRarities(value: string | null): RewardRarity[] {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (
      Array.isArray(parsed) &&
      parsed.every((key) => rewardRarities.some((rarity) => rarity.key === key))
    ) {
      return rewardRarities
        .filter((rarity) => parsed.includes(rarity.key))
        .map((rarity) => rarity.key);
    }
  } catch {
    // Preferences are optional; a damaged value must not prevent history from loading.
  }
  return ['Elite'];
}

/** Display filtering preserves the recruitment's recorded order and original pity values. */
export function filterRewards(rows: Pull[], rarities: RewardRarity[]): Pull[] {
  return rows.filter((row) => rarities.includes(rewardRarity(row.rarity)));
}
