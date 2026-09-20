export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
export const MAX_REVISION_BYTES = 32 * 1024 * 1024;
export const MAX_REVISIONS = 2000;

export interface Revision {
  id: string;
  parents: string[];
  createdAt: string;
  sha256: string;
  fileId: string;
}
export interface RevisionTransport {
  list(): Promise<Revision[]>;
  download(revision: Revision): Promise<Uint8Array>;
  upload(revision: Omit<Revision, 'fileId'>, bytes: Uint8Array): Promise<string>;
}
export class DriveError extends Error {
  code: 'reconnect' | 'quota' | 'network' | 'invalid';
  constructor(code: DriveError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit)
    throw new DriveError('invalid', 'Drive revision exceeds the size limit.');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new DriveError('invalid', 'Drive revision exceeds the size limit.');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function revisionFromFile(file: {
  id: string;
  description?: string;
  appProperties?: Record<string, string>;
}): Revision {
  try {
    const value = JSON.parse(file.description ?? '') as Record<string, unknown>;
    if (
      value.format !== 'gfl2-drive-revision' ||
      value.version !== 1 ||
      typeof value.id !== 'string' ||
      !/^[\w-]{1,100}$/.test(value.id) ||
      value.id !== file.appProperties?.revision ||
      !Array.isArray(value.parents) ||
      value.parents.length > MAX_REVISIONS ||
      !value.parents.every((p) => typeof p === 'string' && /^[\w-]{1,100}$/.test(p)) ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !/^[\w-]+$/.test(file.id)
    )
      throw new Error();
    return {
      id: value.id,
      parents: value.parents as string[],
      createdAt: value.createdAt,
      sha256: value.sha256,
      fileId: file.id
    };
  } catch {
    throw new DriveError(
      'invalid',
      'An unsupported or damaged Drive revision was found. Local data is unchanged.'
    );
  }
}

/** All credentials remain in the supplied closure and never enter filenames or request URLs. */
export function createDriveTransport(
  token: () => string,
  fetcher: typeof fetch = fetch
): RevisionTransport {
  const request = async (url: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: { ...init.headers, Authorization: `Bearer ${token()}` }
      });
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw new DriveError(
        'network',
        'Drive could not be reached. Local data is safe; retry sync when connected.'
      );
    }
    if (response.status === 401)
      throw new DriveError(
        'reconnect',
        'Google authorization expired or was revoked. Reconnect to resume sync.'
      );
    if (response.status === 403 || response.status === 429 || response.status === 507)
      throw new DriveError(
        'quota',
        'Google Drive denied this request or reached a quota. Local data is safe. Check access and storage, then retry.'
      );
    if (!response.ok)
      throw new DriveError(
        'network',
        `Drive sync failed (HTTP ${response.status}). Local data is safe; retry explicitly.`
      );
    return response;
  };
  return {
    async list() {
      const revisions = new Map<string, Revision>();
      let pageToken = '';
      const seenPages = new Set<string>();
      do {
        const params = new URLSearchParams({
          spaces: 'appDataFolder',
          q: "trashed = false and appProperties has { key='tracker' and value='gfl2-v1' }",
          fields: 'nextPageToken,files(id,description,appProperties)',
          pageSize: '1000'
        });
        if (pageToken) params.set('pageToken', pageToken);
        const bytes = await boundedBytes(await request(`${API}?${params}`), 8 * 1024 * 1024);
        let page: { files: Parameters<typeof revisionFromFile>[0][]; nextPageToken?: string };
        try {
          page = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new DriveError('invalid', 'Drive returned invalid revision metadata.');
        }
        if (!Array.isArray(page.files))
          throw new DriveError('invalid', 'Drive returned invalid revision metadata.');
        for (const file of page.files) {
          const revision = revisionFromFile(file);
          const previous = revisions.get(revision.id);
          if (
            previous &&
            (previous.sha256 !== revision.sha256 ||
              JSON.stringify(previous.parents) !== JSON.stringify(revision.parents))
          )
            throw new DriveError('invalid', 'Drive contains conflicting copies of a revision.');
          revisions.set(revision.id, revision);
          if (revisions.size > MAX_REVISIONS)
            throw new DriveError(
              'quota',
              'Drive revision limit reached. Export a local backup before archiving old cloud history.'
            );
        }
        pageToken = page.nextPageToken ?? '';
        if (pageToken && (typeof pageToken !== 'string' || seenPages.has(pageToken)))
          throw new DriveError('invalid', 'Drive returned an invalid page cursor.');
        seenPages.add(pageToken);
      } while (pageToken);
      return [...revisions.values()];
    },
    async download(revision) {
      const bytes = await boundedBytes(
        await request(`${API}/${encodeURIComponent(revision.fileId)}?alt=media`),
        MAX_REVISION_BYTES
      );
      if ((await digest(bytes)) !== revision.sha256)
        throw new DriveError(
          'invalid',
          'Drive backup integrity check failed. Local data is unchanged.'
        );
      return bytes;
    },
    async upload(revision, bytes) {
      if (bytes.length > MAX_REVISION_BYTES)
        throw new DriveError(
          'quota',
          'Compressed backup exceeds the upload limit. Local data is safe.'
        );
      const boundary = `gfl2_${crypto.randomUUID().replaceAll('-', '')}`;
      const metadata = {
        name: `gfl2-${revision.id}.json.gz`,
        mimeType: 'application/gzip',
        parents: ['appDataFolder'],
        appProperties: { tracker: 'gfl2-v1', revision: revision.id },
        description: JSON.stringify({ format: 'gfl2-drive-revision', version: 1, ...revision })
      };
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
        new Uint8Array(bytes).buffer,
        `\r\n--${boundary}--`
      ]);
      // An uncertain POST is never retried here. A later explicit sync lists immutable revisions first.
      const response = await request(UPLOAD, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });
      const result = (await response.json()) as { id?: string };
      if (typeof result.id !== 'string' || !/^[\w-]+$/.test(result.id))
        throw new DriveError(
          'invalid',
          'Drive did not confirm the uploaded revision. Retry sync explicitly to check it.'
        );
      return result.id;
    }
  };
}
