import type { ImportInput } from './api.ts';
import type { Identity } from './local/types.ts';
import { telemetryEnabled } from './telemetry/browser.ts';

export interface VerifiedAccount {
  account_id: string;
  identity: Identity;
}
export interface PublicConfig {
  mode: 'public';
  csrf_token: string;
  features: { server_backup: boolean; community_contribution: boolean; relay_import: boolean };
  identity_verification: { available: boolean; reason: string | null };
  accounts: VerifiedAccount[];
  limits: Record<string, number>;
}
export interface PublicJob {
  id: string;
  status:
    | 'queued'
    | 'running'
    | 'cancelling'
    | 'cancelled'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'interrupted';
  message: string;
  records: number;
  pages: number;
}
export type PublicSnapshot = Omit<ImportInput, 'profile_id'>;
export interface ServerBackup {
  account_id: string;
  name: string;
  snapshots: PublicSnapshot[];
}
export interface CommunityStatistics {
  minimum_contributors: number;
  contributors: number | null;
  total: number | null;
  breakdowns: Record<string, unknown>[];
  suppressed: boolean;
  coverage: 'accessible_history_only';
}
export class PublicApiError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  constructor(message: string, status = 0, uncertain = false) {
    super(message);
    this.name = 'PublicApiError';
    this.status = status;
    this.uncertain = uncertain;
  }
}
/** One explicit request per mutation. A lost response never causes a resubmission. */
export function createPublicClient(fetcher: typeof fetch = fetch) {
  let csrfToken = '';
  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    uncertainMessage?: string
  ): Promise<T> {
    const mutation = method !== 'GET';
    if (mutation && !csrfToken)
      throw new PublicApiError('Initialize the public session before submitting.');
    let response: Response;
    try {
      response = await fetcher(`/api/public/${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'X-GFL2-Telemetry': telemetryEnabled() ? '1' : '0',
          ...(mutation ? { 'X-CSRF-Token': csrfToken } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw new PublicApiError(
        mutation
          ? (uncertainMessage ??
              'The connection ended before the result was confirmed. Check the saved state before submitting again; fetching requires a fresh capture.')
          : 'The public service is unavailable. Your local archive is still saved.',
        0,
        mutation
      );
    }
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      // Never surface upstream error bodies or captured credentials through an API error.
      const messages: Record<number, string> = {
        400: 'The public service rejected the request. Check the supplied data.',
        401: 'Your server session expired. Verify a fresh game capture to reconnect.',
        403: 'This session cannot access that account. Verify a fresh game capture.',
        404: 'This saved item is unavailable or has expired.',
        409: 'The saved state changed. Refresh it before submitting again.',
        413: 'This archive exceeds the server import limit.',
        429: 'The server request limit was reached. Try again later.',
        503: 'Verified server backups and contributions are unavailable for this provider.'
      };
      throw new PublicApiError(
        messages[response.status] ?? 'The public service could not complete the request.',
        response.status
      );
    }
    if (data === null)
      throw new PublicApiError(
        uncertainMessage ?? 'The public service returned an unreadable response.',
        response.status,
        mutation
      );
    return data as T;
  }
  const accountPath = (path: string, accountId: string) =>
    `${path}?${new URLSearchParams({ account_id: accountId })}`;
  return {
    async config() {
      const config = await request<PublicConfig>('config');
      csrfToken = config.csrf_token;
      return config;
    },
    verify(capture: string, server?: string) {
      return request<VerifiedAccount>('verify', 'POST', { capture, ...(server ? { server } : {}) });
    },
    fetchCapture(input: {
      capture: string;
      server?: string;
      save_backup: boolean;
      contribute: boolean;
    }) {
      return request<PublicJob>('fetch', 'POST', input);
    },
    job(id: string) {
      return request<PublicJob>(`jobs/${encodeURIComponent(id)}`);
    },
    cancelJob(id: string) {
      return request<PublicJob>(
        `jobs/${encodeURIComponent(id)}/cancel`,
        'POST',
        {},
        'The stop request could not be confirmed. Keep checking this job for its current status.'
      );
    },
    result(id: string) {
      return request<PublicSnapshot>(`jobs/${encodeURIComponent(id)}/result`);
    },
    backup(accountId: string) {
      return request<ServerBackup>(accountPath('backup', accountId));
    },
    saveBackup(backup: ServerBackup) {
      return request<ServerBackup>('backup', 'PUT', backup);
    },
    deleteBackup(accountId: string) {
      return request<void>(accountPath('backup', accountId), 'DELETE');
    },
    setContribution(accountId: string, enabled: boolean) {
      return request<{ enabled: boolean }>('contribution', 'PUT', {
        account_id: accountId,
        enabled
      });
    },
    deleteContribution(accountId: string) {
      return request<void>(accountPath('contribution', accountId), 'DELETE');
    },
    statistics() {
      return request<CommunityStatistics>('statistics');
    }
  };
}
export type PublicClient = ReturnType<typeof createPublicClient>;
