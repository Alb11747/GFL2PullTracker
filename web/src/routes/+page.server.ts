import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

export function load() {
  return {
    mode: env.GFL2_MODE === 'public' ? ('public' as const) : ('local' as const),
    googleClientId: publicEnv.PUBLIC_GOOGLE_CLIENT_ID || ''
  };
}
