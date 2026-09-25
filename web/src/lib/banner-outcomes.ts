import rules from '../../../backend/banner_rules.json' with { type: 'json' };
import type { Pull } from './api.ts';

export interface BannerRule {
  type_id: number;
  pool_id: number;
  featured: number[];
  kind: string;
  start?: string;
  end?: string;
}
export interface BannerRules {
  hosts: string[];
  pools: BannerRule[];
  fixed_loss_pools?: {
    type_id: number;
    kind: string;
    item_ids: number[];
    start?: string;
    end?: string;
  }[];
}
export interface BannerResult {
  featured: boolean | null;
  outcome: 'win' | 'loss' | 'guaranteed' | 'unknown' | 'not_applicable';
  guarantee_before: boolean | null;
  guarantee_after: boolean | null;
  featured_pity: number | null;
  reason:
    | 'unknown_pool'
    | 'unknown_item'
    | 'unknown_start'
    | 'history_gap'
    | 'guarantee_conflict'
    | 'unsupported_type'
    | 'unknown_provider'
    | null;
}
export interface FeaturedSummary {
  featured_count: number;
  off_banner_count: number;
  wins: number;
  losses: number;
  guaranteed: number;
  unknown_elites: number;
  unknown_outcomes: number;
  featured_intervals: number[];
  current_guarantee: boolean | null;
}

/** Derive once from complete, coverage-annotated history, never a filtered page.
 * Imported outcome flags are deliberately ignored: immutable records and the
 * reviewed pool catalog are the evidence, while gaps invalidate carry state.
 */
export function annotateBannerOutcomes<T extends Pull>(
  rows: T[],
  endpointHost: string | null,
  catalog: BannerRules = rules
): void {
  const knownProvider = endpointHost !== null && catalog.hosts.includes(endpointHost);
  const lookup = new Map<string, BannerRule[]>();
  for (const rule of catalog.pools) {
    const key = `${rule.type_id}/${rule.pool_id}`;
    lookup.set(key, [...(lookup.get(key) || []), rule]);
  }
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    if (!groups.has(row.type_id)) groups.set(row.type_id, []);
    groups.get(row.type_id)!.push(row);
  }
  for (const [type, group] of groups) {
    let guarantee: boolean | null = null;
    let featuredPity: number | null = null;
    let uncertainty: BannerResult['reason'] = 'unknown_start';
    // Stable source order is newest first even within a single timestamp.
    const chronological = [...group].sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        b.timestamp_order - a.timestamp_order ||
        b.id - a.id
    );
    for (const row of chronological) {
      const result: BannerResult = {
        featured: null,
        outcome: 'not_applicable',
        guarantee_before: guarantee,
        guarantee_after: guarantee,
        featured_pity: null,
        reason: null
      };
      row.banner_result = result;
      if (type !== 3 && type !== 4) {
        result.reason = 'unsupported_type';
        continue;
      }
      if (row.gap_before || row.rarity === 'Unknown') {
        guarantee = null;
        featuredPity = null;
        uncertainty = row.gap_before ? 'history_gap' : 'unknown_item';
      }
      const matching = (lookup.get(`${type}/${row.pool_id}`) || []).filter(
        (rule) =>
          (!rule.start || row.timestamp >= rule.start) && (!rule.end || row.timestamp < rule.end)
      );
      const rule = knownProvider && matching.length === 1 ? matching[0] : null;
      const fixedMatches = (catalog.fixed_loss_pools ?? []).filter(
        (pool) =>
          pool.type_id === type &&
          (!pool.start || row.timestamp >= pool.start) &&
          (!pool.end || row.timestamp < pool.end)
      );
      const candidate = fixedMatches.length === 1 ? fixedMatches[0] : null;
      // Standard dolls have also had dedicated rate-ups. Outside their mapped
      // dates, membership in the loss roster alone cannot classify that pool.
      const standardRateUp =
        candidate &&
        (lookup.get(`${type}/${row.pool_id}`) ?? []).some((pool) =>
          pool.featured.some((id) => candidate.item_ids.includes(id))
        );
      const fixed = knownProvider && !standardRateUp ? candidate : null;
      if (!rule && !fixed) {
        guarantee = null;
        featuredPity = null;
        uncertainty = knownProvider ? 'unknown_pool' : 'unknown_provider';
      }
      if (featuredPity !== null) featuredPity++;
      result.guarantee_before = guarantee;
      if (row.rarity === 'Elite') {
        result.outcome = 'unknown';
        // Targeted banners have a known loss roster even when their dated
        // featured mapping is missing. Explicit banner mappings take precedence.
        const kind = rule?.kind ?? fixed?.kind;
        const featured = rule
          ? rule.featured.includes(row.item_id)
          : fixed && !fixed.item_ids.includes(row.item_id);
        if (kind && row.kind === kind && featured) {
          result.featured = true;
          result.outcome =
            guarantee === true ? 'guaranteed' : guarantee === false ? 'win' : 'unknown';
          result.reason = guarantee === null ? uncertainty : null;
          result.featured_pity = featuredPity;
          guarantee = false;
          featuredPity = 0;
          uncertainty = null;
        } else if (kind && row.kind === kind) {
          result.featured = false;
          if (guarantee === true) {
            result.reason = 'guarantee_conflict';
            featuredPity = null;
          } else {
            // An off-banner result itself proves that this roll was not guaranteed.
            result.guarantee_before = false;
            result.outcome = 'loss';
          }
          guarantee = true;
          uncertainty = null;
        } else {
          guarantee = null;
          featuredPity = null;
          uncertainty = rule || fixed ? 'unknown_item' : uncertainty;
          result.reason = uncertainty;
        }
      } else if ((!rule && !fixed) || row.rarity === 'Unknown') {
        result.reason = uncertainty;
      }
      result.guarantee_after = guarantee;
    }
  }
}

/** Summary stays independent of rarity selection and pagination. */
export function summarizeBannerOutcomes(rows: Pull[]): FeaturedSummary {
  const summary: FeaturedSummary = {
    featured_count: 0,
    off_banner_count: 0,
    wins: 0,
    losses: 0,
    guaranteed: 0,
    unknown_elites: 0,
    unknown_outcomes: 0,
    featured_intervals: [],
    current_guarantee: rows[0]?.banner_result?.guarantee_after ?? null
  };
  for (const row of rows) {
    if (row.rarity !== 'Elite' || (row.type_id !== 3 && row.type_id !== 4)) continue;
    const result = row.banner_result;
    if (!result || result.outcome === 'not_applicable') continue;
    if (result?.featured === true) summary.featured_count++;
    else if (result?.featured === false) summary.off_banner_count++;
    else summary.unknown_elites++;
    if (result?.outcome === 'win') summary.wins++;
    else if (result?.outcome === 'loss') summary.losses++;
    else if (result?.outcome === 'guaranteed') summary.guaranteed++;
    else summary.unknown_outcomes++;
    if (result?.featured_pity != null) summary.featured_intervals.push(result.featured_pity);
  }
  return summary;
}
