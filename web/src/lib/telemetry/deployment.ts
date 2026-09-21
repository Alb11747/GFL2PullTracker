export type TelemetryEnvironment = 'production' | 'development' | 'staging' | 'test';

/** Unconfigured builds must not be counted as production traffic. */
export function telemetryEnvironment(value: unknown, development = false): TelemetryEnvironment {
  if (development) return 'development';
  return value === 'production' || value === 'staging' || value === 'test' ? value : 'development';
}
