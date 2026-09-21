import type { HandleClientError } from '@sveltejs/kit';
import { reportBrowserError } from '$lib/telemetry/browser';

export const handleError: HandleClientError = ({ error, status }) => {
  if (status >= 500) reportBrowserError(error);
};
