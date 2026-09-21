import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
  const mode = env.GFL2_MODE === 'public' ? 'public' : 'local';
  if (mode === 'local' && params.section !== 'history') {
    redirect(307, params.section === 'privacy' ? '/privacy-policy' : '/history');
  }
  return { mode, googleClientId: publicEnv.PUBLIC_GOOGLE_CLIENT_ID || '' };
};
