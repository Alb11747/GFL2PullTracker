import rules from '../../../../backend/banner_rules.json' with { type: 'json' };
import type { Pull } from '../api.ts';
import type { BannerResult } from '../banner-outcomes.ts';
import { recruitmentName } from '../recruitment.ts';
import type { ComparisonWindow, HistoryStatistics } from './history-types.ts';

export const STATISTICS_RULES_VERSION = `gfl2-probability-v1:banner-${rules.version}:${rules.source.sha256}`;

export type HistoryRow = Pick<
  Pull,
  'rarity' | 'pity' | 'pity_uncertain' | 'gap_before' | 'banner_result'
>;
export interface HistoryOptions {
  typeId?: number | null;
  name?: string;
  startingPity?: number | null;
  guaranteed?: boolean | null;
}
const featuredReasons: Partial<Record<NonNullable<BannerResult['reason']>, string>> = {
  unknown_pool:
    'The latest banner cannot be classified with the available banner and standard-pool data.',
  unknown_provider: 'The latest history provider has no reviewed banner classification.',
  unknown_item:
    'An unknown item interrupts the latest stretch; no later classified 5★ establishes a new start.',
  guarantee_conflict:
    'The latest reward conflicts with the expected guarantee; a new starting state is needed.',
  unsupported_type: 'Featured classification is not supported for this recruitment type.',
  history_gap: 'The latest history gap has no later classified 5★ to establish a new start.'
};
const classificationBreaks = new Set<BannerResult['reason']>([
  'unknown_pool',
  'unknown_provider',
  'unknown_item',
  'guarantee_conflict',
  'unsupported_type'
]);

/** Analyze complete coverage/classification-annotated rows in stable newest-first order.
 * A reward that establishes state is an excluded anchor, never a free observed success.
 * Every later pull counts, including trailing pulls with no further reward.
 */
export function analyzeHistory(
  rows: readonly HistoryRow[],
  options: HistoryOptions = {}
): HistoryStatistics {
  const first = rows.at(-1);
  const initialPity =
    options.startingPity ??
    (first && !first.pity_uncertain && !first.gap_before && first.rarity !== 'Unknown'
      ? first.pity - 1
      : null);
  const initialGuarantee = options.guaranteed ?? null;
  const result: HistoryStatistics = {
    schemaVersion: 2,
    typeId: options.typeId ?? null,
    name: options.name ?? 'Recruitment history',
    total: rows.length,
    eliteCount: 0,
    intervals: [],
    excludedCount: 0,
    currentPity: null,
    currentGuarantee: rows[0]?.banner_result?.guarantee_after ?? null,
    featuredCount: 0,
    unknownFeaturedCount: 0,
    featuredIntervals: [],
    wins: { wins: 0, trials: 0, guaranteed: 0, unknown: 0 },
    windows: { elite: null, featured: null },
    windowReasons: {
      elite: 'Starting pity is unknown; no later 5★ establishes a start.',
      featured: 'Starting pity and guarantee are not established.'
    }
  };
  const window = (pity: number, guaranteed: boolean, startLabel: string): ComparisonWindow => ({
    budget: 0,
    count: 0,
    eliteCount: 0,
    startingPity: pity,
    guaranteed,
    startLabel
  });
  let elite = initialPity === null ? null : window(initialPity, false, 'Known starting pity');
  let featured =
    initialPity === null || initialGuarantee === null
      ? null
      : window(initialPity, initialGuarantee, 'Known starting pity and guarantee');
  // Reverse iteration preserves engine source ordering for timestamp ties without copying rows.
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const banner = row.banner_result;
    const isElite = row.rarity === 'Elite';
    const pityBreak = row.gap_before || row.rarity === 'Unknown';
    const unknownFeatured = isElite && banner?.featured == null;
    const featuredBreak =
      pityBreak ||
      !banner ||
      unknownFeatured ||
      banner.guarantee_after === null ||
      classificationBreaks.has(banner.reason);
    if (pityBreak) {
      elite = null;
      result.windowReasons.elite =
        row.rarity === 'Unknown'
          ? 'An unknown item interrupts the latest stretch; no later 5★ establishes a new start.'
          : 'The latest history gap has no later 5★ to establish a new start.';
    }
    if (featuredBreak) {
      featured = null;
      const reason = banner?.reason ? featuredReasons[banner.reason] : undefined;
      // Unknown carry on ordinary later pulls must not erase the actual cause.
      if (reason) result.windowReasons.featured = reason;
      else if (row.rarity === 'Unknown')
        result.windowReasons.featured = featuredReasons.unknown_item!;
      else if (row.gap_before) result.windowReasons.featured = featuredReasons.history_gap!;
      else if (!banner)
        result.windowReasons.featured = 'The latest history has no reviewed banner classification.';
      else if (unknownFeatured)
        result.windowReasons.featured =
          'The latest 5★ has unknown featured identity; a classified 5★ is needed to establish a new start.';
    }
    if (elite) {
      elite.budget++;
      if (isElite) {
        elite.count++;
        elite.eliteCount++;
      }
    }
    if (featured) {
      featured.budget++;
      if (isElite) featured.eliteCount++;
      if (isElite && banner?.featured === true) featured.count++;
    }
    if (isElite) {
      result.eliteCount++;
      if (row.pity_uncertain) result.excludedCount++;
      else result.intervals.push(row.pity);
      if (banner?.featured === true) result.featuredCount++;
      else if (banner?.featured !== false) result.unknownFeaturedCount++;
      if (banner?.featured_pity != null) result.featuredIntervals.push(banner.featured_pity);
      if (banner?.outcome === 'win') {
        result.wins.wins++;
        result.wins.trials++;
      } else if (banner?.outcome === 'loss') result.wins.trials++;
      else if (banner?.outcome === 'guaranteed') result.wins.guaranteed++;
      else result.wins.unknown++;
      if (!elite) elite = window(0, false, 'After an observed 5★ (anchor excluded)');
      if (!featured && banner?.featured != null && banner.guarantee_after !== null)
        featured = window(0, banner.guarantee_after, 'After a classified 5★ (anchor excluded)');
    }
  }
  result.intervals.reverse();
  result.featuredIntervals.reverse();
  const latest = rows[0];
  result.currentPity =
    latest?.rarity === 'Elite' ? 0 : latest && !latest.pity_uncertain ? latest.pity : null;
  result.windows = { elite, featured };
  if (elite)
    result.windowReasons.elite =
      'Latest continuous stretch with known starting pity, including trailing pulls.';
  if (featured)
    result.windowReasons.featured =
      'Latest continuous stretch with known starting pity and guarantee, including trailing pulls.';
  return result;
}

/** Group and cache once per immutable profile revision, independently of reward filters. */
export function createStatisticsQuery(rows: readonly Pull[]) {
  const groups = new Map<number, Pull[]>();
  for (const row of rows) {
    if (!groups.has(row.type_id)) groups.set(row.type_id, []);
    groups.get(row.type_id)!.push(row);
  }
  const types = [...groups.keys()].sort((a, b) => a - b);
  const summaries = new Map<number | null, HistoryStatistics>();
  return (typeId: number | null) => {
    const selectedType =
      typeId !== null && groups.has(typeId) ? typeId : types.includes(3) ? 3 : (types[0] ?? null);
    if (!summaries.has(selectedType))
      summaries.set(
        selectedType,
        analyzeHistory(selectedType === null ? [] : groups.get(selectedType)!, {
          typeId: selectedType,
          name: selectedType === null ? 'Recruitment history' : recruitmentName(selectedType)
        })
      );
    return { types, selectedType, summary: summaries.get(selectedType)! };
  };
}
