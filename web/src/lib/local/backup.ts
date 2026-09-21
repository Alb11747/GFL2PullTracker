import {
  canonical,
  digest,
  InvalidArchiveError,
  MAX_STATE_BYTES,
  object,
  validateState
} from './engine.ts';
import type { PortableState } from './types.ts';
import { MAX_COMPRESSED_BYTES } from './limits.ts';
export { MAX_COMPRESSED_BYTES } from './limits.ts';

/** Distinguishes rejected content from interrupted workers or other operational failures. */
export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBackupError';
  }
}
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Backup exceeds the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  return bytes;
}
/** Integrity detects corruption; it is not a server verification or authenticity claim. */
export async function encodeBackup(input: PortableState): Promise<Uint8Array> {
  const state = await validateState(input);
  const envelope = {
    format: 'gfl2-pull-tracker-backup',
    sha256: await digest(state),
    state
  };
  const bytes = new TextEncoder().encode(canonical(envelope));
  if (bytes.length > MAX_STATE_BYTES) throw new Error('Backup exceeds the expanded size limit.');
  return readBounded(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
    MAX_COMPRESSED_BYTES
  );
}
export async function decodeBackup(bytes: Uint8Array): Promise<PortableState> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_COMPRESSED_BYTES)
    throw new InvalidBackupError('Backup exceeds the 16 MiB compressed limit.');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    throw new InvalidBackupError('Expected a gzip-compressed tracker backup.');
  // Platform support failures are operational; only decoding rejects the content.
  const stream = new Blob([new Uint8Array(bytes).buffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  let expanded: Uint8Array;
  try {
    expanded = await readBounded(stream, MAX_STATE_BYTES);
  } catch (cause) {
    if (
      cause instanceof RangeError ||
      (cause instanceof DOMException && cause.name === 'AbortError')
    )
      throw cause;
    throw new InvalidBackupError('Backup is damaged or exceeds the expanded size limit.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let envelope: Record<string, unknown>;
  try {
    envelope = object(JSON.parse(decoder.decode(expanded)), 'backup');
  } catch (cause) {
    if (!(
      cause instanceof SyntaxError ||
      cause instanceof TypeError ||
      cause instanceof InvalidArchiveError
    ))
      throw cause;
    throw new InvalidBackupError('Backup does not contain valid JSON.');
  }
  if (envelope.format !== 'gfl2-pull-tracker-backup' || 'version' in envelope)
    throw new InvalidBackupError('Unsupported compressed backup format.');
  let state: PortableState;
  try {
    state = await validateState(envelope.state);
  } catch (cause) {
    if (cause instanceof InvalidArchiveError) throw new InvalidBackupError(cause.message);
    throw cause;
  }
  if (envelope.sha256 !== (await digest(state)))
    throw new InvalidBackupError('Backup integrity check failed.');
  return state;
}
