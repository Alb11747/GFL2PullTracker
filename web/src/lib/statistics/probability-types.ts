export interface ProbabilityParameters {
  base: number;
  soft: number;
  max: number;
  p: number;
}

export type Reward = 'elite' | 'featured';
export const DEFAULT_PLANNER_BUDGET = 75;
export const DEFAULT_REWARD: Reward = 'featured';
export const MODELS = {
  dolls: { base: 0.006, soft: 59, max: 80, p: 0.5 },
  weapons: { base: 0.007, soft: 51, max: 70, p: 0.75 }
} satisfies Record<string, ProbabilityParameters>;

export interface RewardWindow {
  budget: number;
  count: number;
  startingPity?: number;
  guaranteed?: boolean;
}

export interface WinsObservation {
  wins: number;
  trials: number;
}

export interface PlannerInput {
  p: ProbabilityParameters;
  budget: number;
  startingPity?: number;
  guaranteed?: boolean;
}

export interface SummaryInput {
  p: ProbabilityParameters;
  windows?: Partial<Record<Reward, RewardWindow | null>>;
  wins?: WinsObservation | null;
}

export interface AcquisitionInput {
  p: ProbabilityParameters;
  intervals?: readonly number[] | null;
  featuredIntervals?: readonly number[] | null;
  wins?: WinsObservation | null;
}

export interface ProbabilityError {
  code: string;
  message: string;
}

export interface ProbabilityMetric {
  dist: Float64Array;
  missing: boolean;
  expected: number;
  error?: ProbabilityError;
  tail?: number;
  observation?: number;
  count?: number;
  n?: number;
  budget?: number;
  low?: number;
  high?: number;
  chanceAtLeastOne?: number;
  omittedMassBound?: number;
  expectedErrorBound?: number;
  approximation?: 'exact' | 'bounded-renewal';
}

export interface PlannerResult {
  elite: ProbabilityMetric;
  featured: ProbabilityMetric;
}

export interface HistoryProbabilityResult extends PlannerResult {
  wins: ProbabilityMetric;
}

export type ProbabilityRequest =
  | ({ method: 'planner' } & PlannerInput)
  | ({ method: 'summary' } & SummaryInput)
  | ({ method: 'acquisition' } & AcquisitionInput);

export type ProbabilityResult = PlannerResult & { wins?: ProbabilityMetric };
export type ProbabilityWorkerRequest = ProbabilityRequest & { id: number };
export type ProbabilityWorkerResponse =
  | { id: number; result: ProbabilityResult; error?: never }
  | { id: number; error: ProbabilityError; result?: never };
