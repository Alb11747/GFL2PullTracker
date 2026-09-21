import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { backendUrl } from '$lib/proxy';
import { reportServerError } from '$lib/telemetry/server';
import { requestTelemetryAllowed } from '$lib/telemetry/server-policy';

export const handleError: HandleServerError = ({ error, event, status }) => {
  // SvelteKit also calls this hook for expected failures such as unmatched routes.
  if (status >= 500)
    reportServerError(error, 'request', requestTelemetryAllowed(event.request.headers));
  return { message: 'The tracker could not complete this request.' };
};

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
  // HTML contains runtime settings and CSP nonces; keep it out of shared and
  // browser caches without changing the caching policy for immutable assets.
  if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() === 'text/html')
    response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (env.GFL2_MODE === 'public')
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
};
