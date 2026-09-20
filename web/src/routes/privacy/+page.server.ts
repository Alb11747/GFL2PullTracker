import { env } from '$env/dynamic/public';

export function load() {
  const email = env.PUBLIC_SUPPORT_EMAIL?.trim() ?? '';
  return {
    supportEmail: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : '',
    hostingDetails: env.PUBLIC_HOSTING_DETAILS?.trim() ?? '',
    logRetention: env.PUBLIC_LOG_RETENTION?.trim() ?? ''
  };
}
