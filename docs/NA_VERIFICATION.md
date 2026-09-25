# NA capture verification findings

## Status

NA account ownership verification remains disabled. A read-only feasibility check
on 2026-09-25 did not establish a trusted binding between the captured credentials
and a stable account identity. Do not enable server backup, recovery, contribution,
or deletion based only on a successful history request or decoded token metadata.

## Observed behavior

The check targeted the official NA `/list` endpoint at
`gf2-gacha-record-us.sunborngame.com`, using one user-supplied capture in memory.
Four requests were made, without retries or pagination. No personal history was
uploaded to the tracker, and no raw credentials, identifiers, or history were
saved as evidence or fixtures.

| Case | HTTP status | API code | Result |
| --- | --- | --- | --- |
| Original capture | 200 | 0 | Nonempty history list; no checked identity fields |
| Altered signature segment | 200 | 0 | Nonempty history list; no checked identity fields |
| Replaced token `openid` with an invalid sentinel | 200 | -1 | No data object |
| Replaced URL `u` with an invalid sentinel | 200 | 0 | Nonempty history list; no checked identity fields |

The decoded token contained `uid: 0` and a separate `openid`. The user confirmed
that their actual game UID was nonzero. The sanitized response inspection checked
`uid`, `user_id`, `role_id`, `openid`, `server`, `tinx`, and `game_channel_id` at the
response root, in `data`, and in its `user`, `player`, `profile`, and `info` objects.
It did not inspect or retain individual pull records.

These observations apply to this capture and endpoint at the time of the check.
They do not establish that every token signature is ignored, that the successful
responses contained identical histories, or that any other account is accessible.
An invalid `openid` failing does not prove signature validation. A supplied `u`
value being accepted does not authenticate that identifier.

## Cross-capture and saved-history comparison

A follow-up compared the user's 2026-09-21 capture from the earlier import task
with the 2026-09-25 capture, without retaining either token in the repository.
Their `openid` values match exactly, while the token expiry and signature differ.
Both tokens have `uid: 0` and the same server metadata. This demonstrates observed
identifier continuity across two distinct captures four days apart; it does not
establish behavior across every login, token rotation, or account-linking event.

The original recovery archive was read without modification. One initial page
contained only newer pulls, so a second bounded read checked five pages. Of the
30 records in that second read, 10 were newer than the saved category's latest
record; the remaining 20 exactly matched a consecutive sequence in the original
import, preserving order and duplicate multiplicity. The captured account
fingerprint, server, and channel also matched the saved import. No fetched
records or identifier values were saved or added to fixtures.

These results support using `openid` as a candidate account key: it persisted
across changed tokens and selected history consistent with the previous import.
They do not resolve whether it is a public identifier or a secret bearer
capability, or establish an authenticated binding suitable for private recovery.

## Required before implementation can proceed

A provider adapter should prefer the actual in-game UID, but a stable
provider-issued account ID is an acceptable fallback. Missing UID alone must not
block a provider whose alternative account binding has been demonstrated.

The adapter still needs an official response or verifiable provider signature
that establishes the chosen ID and its binding to the captured credentials,
server, and channel. Neither a user-entered UID nor the current decoded token
metadata provides that evidence. The token's `openid` now has demonstrated
continuity across the two captures above, but its role as an identifier versus
an access credential has not been established. Do not publish it or repurpose it as a public account
label. No suitable identity endpoint or signature contract has yet been
established; this is not proof that none exists.

If a provider-ID fallback is established, represent its identity kind explicitly
instead of storing it as a game UID. Scope account keys by provider, region/server,
channel, identity kind, and the verified identifier. Preserve existing UID-keyed
accounts and require verified linkage before merging identities.

After establishing that contract, test valid and rejected credentials, identity
mismatches, refresh stability, and account isolation. Enable only the demonstrated
provider/region through provider-specific capabilities and reuse the existing
session grants. Preserve all saved histories and snapshots.

The current production verifier remains absent. No adapter, capability enablement,
database change, or deployment was made as part of this feasibility check.
