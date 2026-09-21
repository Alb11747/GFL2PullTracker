import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { telemetryEnvironment } from '$lib/telemetry/deployment';
import { env as publicEnv } from '$env/dynamic/public';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => ({
  telemetry: {
    enabled: env.GFL2_MODE === 'public' && Boolean(publicEnv.PUBLIC_POSTHOG_KEY),
    key: publicEnv.PUBLIC_POSTHOG_KEY || '',
    host: publicEnv.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    release: publicEnv.PUBLIC_APP_RELEASE || '',
    environment: telemetryEnvironment(env.GFL2_TELEMETRY_ENVIRONMENT, dev)
  }
});
