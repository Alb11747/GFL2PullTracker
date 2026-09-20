import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { forward } from '$lib/proxy';
const handle: RequestHandler = ({ request }) =>
  forward(request, env.GFL2_API_URL || 'http://127.0.0.1:8000');
export const GET = handle;
export const POST = handle;
