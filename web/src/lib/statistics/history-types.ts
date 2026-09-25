import type { Profile } from '../api.ts';
import type { RewardWindow } from './probability-types.ts';

/** Pulls and observed rewards since a proven starting state, including trailing pulls. */
export interface ComparisonWindow extends RewardWindow {
  budget: number;
  count: number;
  /** All five-stars in this same window, including non-featured rewards. */
  eliteCount: number;
  startingPity: number;
  guaranteed: boolean;
  startLabel?: string;
}

export interface HistoryStatistics {
  schemaVersion: 2;
  typeId: number | null;
  name: string;
  total: number;
  eliteCount: number;
  intervals: number[];
  excludedCount: number;
  currentPity: number | null;
  currentGuarantee: boolean | null;
  featuredCount: number;
  unknownFeaturedCount: number;
  featuredIntervals: number[];
  wins: { wins: number; trials: number; guaranteed: number; unknown: number };
  windows: { elite: ComparisonWindow | null; featured: ComparisonWindow | null };
  windowReasons: { elite: string; featured: string };
}

/** Only aggregates cross the statistics worker boundary; raw records stay in the archive. */
export interface PersonalStatisticsResponse {
  types: number[];
  selectedType: number | null;
  summary: HistoryStatistics;
  identity: Pick<Profile, 'account_fingerprint' | 'endpoint_host' | 'server' | 'game_channel_id'>;
  rulesVersion: string;
}
