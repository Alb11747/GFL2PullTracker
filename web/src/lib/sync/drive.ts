import { ARCHIVE_VERSION, STABLE_ARCHIVE_NAMESPACE } from '../local/types.ts';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version,size';
export const MAX_REVISION_BYTES = 16 * 1024 * 1024;
export const MAX_REVISIONS = 2000;

export interface Revision {
  id: string;
  parents: string[];
  createdAt: string;
  sha256: string;
  fileId: string;
  /** Drive's observed file generation, not an archive schema version. */
  contentVersion: string;
}
export type NewRevision = Omit<Revision, 'fileId' | 'contentVersion'>;
export type PublishedRevision = Pick<Revision, 'fileId' | 'contentVersion'>;
export interface RevisionTransport {
  list(): Promise<Revision[]>;
  /** Proven-invalid metadata from the last complete listing; cleanup waits for payload audits. */
  pendingInvalidFiles?(): readonly string[];
  download(revision: Revision): Promise<Uint8Array>;
  upload(revision: NewRevision, bytes: Uint8Array): Promise<PublishedRevision>;
  delete(fileId: string): Promise<void>;
}
export class DriveError extends Error {
  code: 'reconnect' | 'quota' | 'network' | 'invalid' | 'unsupported';
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
interface DriveFile {
  id: string;
  description?: string;
  appProperties?: Record<string, string>;
  version?: string;
  size?: string;
}

function observedContentVersion(file: DriveFile): string {
  // Drive documents `version` as increasing for every server-side file change.
  // Preserve its int64 string: coercing it to Number could miss later changes.
  if (
    typeof file.version !== 'string' ||
    !/^\d{1,20}$/.test(file.version) ||
    typeof file.size !== 'string' ||
    !/^\d{1,20}$/.test(file.size)
  )
    throw new DriveError('invalid', 'Drive returned invalid observed file metadata.');
  return `${file.version}:${file.size}`;
}

function revisionFromFile(file: DriveFile, contentVersion: string): Revision {
  try {
    const value = JSON.parse(file.description ?? '') as Record<string, unknown>;
    if (value.format === 'gfl2-drive-revision' && value.version !== ARCHIVE_VERSION)
      throw new DriveError(
        'unsupported',
        'Unsupported Drive archive version. Update the tracker before syncing. No cloud files or local data were changed.'
      );
    if (
      value.format !== 'gfl2-drive-revision' ||
      value.version !== ARCHIVE_VERSION ||
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
      fileId: file.id,
      contentVersion
    };
  } catch (error) {
    if (error instanceof DriveError && error.code === 'unsupported') throw error;
    throw new DriveError(
      'invalid',
      'An unsupported or damaged Drive revision was found. Refresh the tracker before retrying. Local data is unchanged.'
    );
  }
}

/** All credentials remain in the supplied closure and never enter filenames or request URLs. */
export function createDriveTransport(
  token: () => string,
  fetcher: typeof fetch = fetch
): RevisionTransport {
  let pendingInvalid: string[] = [];
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
    if (!response.ok && !(init.method === 'DELETE' && response.status === 404))
      throw new DriveError(
        'network',
        `Drive sync failed (HTTP ${response.status}). Local data is safe; retry explicitly.`
      );
    return response;
  };
  const remove = async (fileId: string) => {
    if (!/^[\w-]+$/.test(fileId)) throw new DriveError('invalid', 'Invalid Drive file identifier.');
    await request(`${API}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  };
  return {
    pendingInvalidFiles: () => [...pendingInvalid],
    async list() {
      pendingInvalid = [];
      const revisions = new Map<string, Revision>();
      const validFiles: Revision[] = [];
      const invalidFiles = new Set<string>();
      const filesByRevision = new Map<string, string[]>();
      const conflicting = new Set<string>();
      const seenFiles = new Map<string, string>();
      let fileCount = 0;
      let pageToken = '';
      const seenPages = new Set<string>();
      do {
        const params = new URLSearchParams({
          spaces: 'appDataFolder',
          q: `trashed = false and appProperties has { key='tracker' and value='${STABLE_ARCHIVE_NAMESPACE}' }`,
          fields: 'nextPageToken,files(id,description,appProperties,version,size)',
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
        if (!page || typeof page !== 'object' || !Array.isArray(page.files))
          throw new DriveError('invalid', 'Drive returned invalid revision metadata.');
        for (const file of page.files) {
          if (++fileCount > MAX_REVISIONS)
            throw new DriveError(
              'quota',
              'Drive revision limit reached. No cloud files were changed.'
            );
          if (!file || typeof file.id !== 'string' || !/^[\w-]+$/.test(file.id))
            throw new DriveError('invalid', 'Drive returned an invalid file identifier.');
          if (file.appProperties?.tracker !== STABLE_ARCHIVE_NAMESPACE)
            throw new DriveError('invalid', 'Drive returned a file outside this tracker archive.');
          const contentVersion = observedContentVersion(file);
          const metadata = JSON.stringify([file.description, file.appProperties, contentVersion]);
          const seen = seenFiles.get(file.id);
          if (seen !== undefined) {
            if (seen !== metadata)
              throw new DriveError('network', 'Drive metadata changed during listing. Retry sync.');
            continue;
          }
          seenFiles.set(file.id, metadata);
          let revision: Revision;
          try {
            revision = revisionFromFile(file, contentVersion);
          } catch (error) {
            if (!(error instanceof DriveError) || error.code !== 'invalid') throw error;
            invalidFiles.add(file.id);
            continue;
          }
          if (BigInt(file.size!) > BigInt(MAX_REVISION_BYTES)) {
            invalidFiles.add(file.id);
            continue;
          }
          const copies = filesByRevision.get(revision.id) ?? [];
          copies.push(file.id);
          filesByRevision.set(revision.id, copies);
          const previous = revisions.get(revision.id);
          if (
            previous &&
            (previous.sha256 !== revision.sha256 ||
              previous.createdAt !== revision.createdAt ||
              JSON.stringify(previous.parents) !== JSON.stringify(revision.parents))
          )
            conflicting.add(revision.id);
          validFiles.push(revision);
          revisions.set(revision.id, revision);
          if (revisions.size > MAX_REVISIONS)
            throw new DriveError(
              'quota',
              'Drive revision limit reached. Export a local backup before archiving old cloud history.'
            );
        }
        if (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')
          throw new DriveError('invalid', 'Drive returned an invalid page cursor.');
        pageToken = page.nextPageToken ?? '';
        if (pageToken && seenPages.has(pageToken))
          throw new DriveError('invalid', 'Drive returned an invalid page cursor.');
        seenPages.add(pageToken);
      } while (pageToken);
      // Never act on a partial listing: a later page may be malformed or unavailable.
      for (const id of conflicting) {
        for (const fileId of filesByRevision.get(id)!) invalidFiles.add(fileId);
        revisions.delete(id);
      }
      // The controller must also rule out unsupported payload versions before
      // removing anything. A metadata listing by itself never changes Drive.
      pendingInvalid = [...invalidFiles];
      // Keep identical copies visible so every physical payload gets audited.
      return validFiles.filter((revision) => !conflicting.has(revision.id));
    },
    async download(revision) {
      const bytes = await boundedBytes(
        await request(`${API}/${encodeURIComponent(revision.fileId)}?alt=media`),
        MAX_REVISION_BYTES
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
        appProperties: { tracker: STABLE_ARCHIVE_NAMESPACE, revision: revision.id },
        description: JSON.stringify({
          ...revision,
          format: 'gfl2-drive-revision',
          version: ARCHIVE_VERSION
        })
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
      const result = (await response.json()) as DriveFile;
      if (typeof result.id !== 'string' || !/^[\w-]+$/.test(result.id))
        throw new DriveError(
          'invalid',
          'Drive did not confirm the uploaded revision. Retry sync explicitly to check it.'
        );
      return { fileId: result.id, contentVersion: observedContentVersion(result) };
    },
    delete: remove
  };
}
