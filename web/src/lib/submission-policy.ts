import { IDENTITY_FIELDS, identityKey, type Identity } from './local/types.ts';
import type { PublicSnapshot } from './public-api.ts';

/** A bound profile may contain older unbound snapshots; inspect the actual uploaded documents. */
export function snapshotSubmissionIdentity(
  snapshots: PublicSnapshot[],
  verified: Identity & { uid: string }
): 'matched' | 'associate' | 'conflict' {
  let incomplete = false;
  for (const snapshot of snapshots) {
    for (const metadata of [snapshot.records_document, snapshot.manifest ?? {}]) {
      for (const field of [...IDENTITY_FIELDS, 'uid'] as const)
        if (metadata[field] != null && metadata[field] !== verified[field]) return 'conflict';
    }
    if (IDENTITY_FIELDS.some((field) => snapshot.records_document[field] == null))
      incomplete = true;
  }
  return incomplete ? 'associate' : 'matched';
}

/** Partial local identity needs explicit association; known conflicts must not be relabelled. */
export function submissionIdentity(
  local: Identity,
  verified: Identity
): 'matched' | 'associate' | 'conflict' {
  if (
    IDENTITY_FIELDS.some(
      (key) => local[key] != null && local[key] !== '' && local[key] !== verified[key]
    )
  )
    return 'conflict';
  return identityKey(local) === null ? 'associate' : 'matched';
}
