import type { PublicConfig } from './public-api.ts';

export function serverCapabilities(config?: PublicConfig) {
  const verified = config?.identity_verification.available === true;
  return {
    backup: verified && config?.features.server_backup === true,
    contribution: verified && config?.features.community_contribution === true,
    relay: config?.features.relay_import === true
  };
}

export function savedServerChoices(
  config: PublicConfig | undefined,
  backup: string | null,
  contribution: string | null
) {
  const available = serverCapabilities(config);
  return {
    saveBackup: available.backup && backup === 'true',
    contribute: available.contribution && contribution === 'true'
  };
}
