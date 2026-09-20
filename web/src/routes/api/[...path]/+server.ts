import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestHandler } from './$types';
import { forward } from '$lib/proxy';
const handle: RequestHandler = ({ request }) =>
  forward(request, env.GFL2_API_URL || 'http://127.0.0.1:8000', fetch, {
    mode: env.GFL2_MODE === 'public' ? 'public' : 'local',
    publicOrigin: publicEnv.PUBLIC_ORIGIN || env.GFL2_FRONTEND_ORIGIN,
    allowedBackends: (env.GFL2_API_ALLOWED_ORIGINS || '').split(',').filter(Boolean)
  });
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
