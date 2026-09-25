import type { PublicSnapshot, ServerBackup } from './public-api.ts';

export type HistorySubmission = ServerBackup & { expected_version: number; associate: boolean };

/** Plan every bounded request before saving anything; one oversized snapshot fails locally. */
export function submissionBatches(
  input: HistorySubmission,
  requestBytes = 16 * 1024 * 1024
): HistorySubmission[] {
  if (!input.snapshots.length) throw new Error('This profile has no history to submit.');
  const encode = new TextEncoder();
  const limit = Math.min(requestBytes, 16 * 1024 * 1024);
  const baseBytes = encode.encode(JSON.stringify({ ...input, snapshots: [] })).length;
  const result: HistorySubmission[] = [];
  let snapshots: PublicSnapshot[] = [];
  let bytes = baseBytes;
  for (const snapshot of input.snapshots) {
    const size = encode.encode(JSON.stringify(snapshot)).length;
    if (baseBytes + size > limit)
      throw new Error(
        'One history snapshot exceeds the server request limit. Your local history is unchanged.'
      );
    if (snapshots.length === 100 || bytes + size + (snapshots.length ? 1 : 0) > limit) {
      result.push({ ...input, snapshots });
      snapshots = [];
      bytes = baseBytes;
    }
    bytes += size + (snapshots.length ? 1 : 0);
    snapshots.push(snapshot);
  }
  result.push({ ...input, snapshots });
  return result;
}
