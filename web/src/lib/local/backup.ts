import { canonical, digest, MAX_STATE_BYTES, object, validateState } from './engine.ts';
import type { PortableState } from './types.ts';

export const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
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
    version: 1,
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
    throw new Error('Backup exceeds the 16 MiB compressed limit.');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    throw new Error('Expected a gzip-compressed tracker backup.');
  let expanded: Uint8Array;
  try {
    expanded = await readBounded(
      new Blob([new Uint8Array(bytes).buffer])
        .stream()
        .pipeThrough(new DecompressionStream('gzip')),
      MAX_STATE_BYTES
    );
  } catch {
    throw new Error('Backup is damaged or exceeds the expanded size limit.');
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = object(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded)),
      'backup'
    );
  } catch {
    throw new Error('Backup does not contain valid JSON.');
  }
  if (envelope.format !== 'gfl2-pull-tracker-backup' || envelope.version !== 1)
    throw new Error('Unsupported compressed backup format or version.');
  const state = await validateState(envelope.state);
  if (envelope.sha256 !== (await digest(state))) throw new Error('Backup integrity check failed.');
  return state;
}
