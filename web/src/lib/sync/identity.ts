interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
export interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(options: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: TokenResponse) => void;
        error_callback: () => void;
      }): { requestAccessToken(options: { prompt: string }): void };
    };
  };
}
type BrowserWithGoogle = Window & { google?: GoogleIdentity };
let identityLoading: Promise<GoogleIdentity> | null = null;

/** Bound the script download, never the time a person spends signing in. */
export function loadIdentity(): Promise<GoogleIdentity> {
  if (typeof window === 'undefined')
    return Promise.reject(new Error('Google authorization requires a browser.'));
  const available = (window as BrowserWithGoogle).google;
  if (available) return Promise.resolve(available);
  if (identityLoading) return identityLoading;
  let resolve!: (google: GoogleIdentity) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<GoogleIdentity>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  identityLoading = pending;
  let script: HTMLScriptElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  function settle(google?: GoogleIdentity) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (script) {
      script.onload = null;
      script.onerror = null;
    }
    if (google) resolve(google);
    else {
      if (identityLoading === pending) identityLoading = null;
      script?.remove();
      reject(
        new Error('Google authorization could not load. Check your connection and reconnect.')
      );
    }
  }
  try {
    script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => settle((window as BrowserWithGoogle).google);
    script.onerror = () => settle();
    timer = setTimeout(() => settle(), 15_000);
    document.head.append(script);
  } catch {
    settle();
  }
  return pending;
}
