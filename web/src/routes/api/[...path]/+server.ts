import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestHandler } from './$types';
import { forward } from '$lib/proxy';
const handle: RequestHandler = ({ request, getClientAddress }) => {
  let clientAddress: string | undefined;
  if (env.GFL2_MODE === 'public') {
    // An absent/misconfigured ingress header fails closed instead of sharing
    // one container-address quota across every visitor.
    try {
      if (env.ADDRESS_HEADER !== 'x-real-ip') throw new Error('Untrusted address configuration');
      clientAddress = getClientAddress();
    } catch {
      return Response.json(
        { detail: 'A valid trusted client address is required.' },
        { status: 400 }
      );
    }
  }
  return forward(request, env.GFL2_API_URL || 'http://127.0.0.1:8000', fetch, {
    mode: env.GFL2_MODE === 'public' ? 'public' : 'local',
    publicOrigin: publicEnv.PUBLIC_ORIGIN || env.GFL2_FRONTEND_ORIGIN,
    allowedBackends: (env.GFL2_API_ALLOWED_ORIGINS || '').split(',').filter(Boolean),
    clientAddress
  });
};
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
