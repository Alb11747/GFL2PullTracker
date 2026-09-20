import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { Handle } from '@sveltejs/kit';
import { backendUrl } from '$lib/proxy';

if (env.GFL2_MODE === 'public') {
  const origin = new URL(publicEnv.PUBLIC_ORIGIN || env.GFL2_FRONTEND_ORIGIN || '');
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== origin.href.replace(/\/$/, '') ||
    origin.username ||
    origin.password
  )
    throw new Error('Public hosting requires a bare HTTPS PUBLIC_ORIGIN.');
  backendUrl(
    env.GFL2_API_URL || '',
    (env.GFL2_API_ALLOWED_ORIGINS || '').split(',').filter(Boolean)
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (env.GFL2_MODE === 'public')
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
};
