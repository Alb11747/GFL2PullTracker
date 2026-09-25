import type { PublicConfig } from './public-api.ts';

export function serverCapabilities(config?: PublicConfig) {
  return {
    submission:
      config?.identity_verification.available === true && config?.features.submit_history === true,
    relay: config?.features.relay_import === true
  };
}

/** A remembered opt-out wins; unavailable providers never submit history. */
export function savedServerChoices(config: PublicConfig | undefined, submission: string | null) {
  return { submitHistory: serverCapabilities(config).submission && submission !== 'false' };
}
