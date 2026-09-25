# Featured rewards and guarantee state

History and reward queries derive `banner_result` from the complete merged
profile before filtering or pagination. The browser worker and local Python API
use the same reviewed `backend/banner_rules.json` and ordering contract. Original
records and portable archives are unchanged; there is no database migration.
Personal statistics and server-history comparisons use the same derived outcomes.

## Evidence and supported coverage

A recorded reward's pool ID and timestamp select exactly one catalog entry.
Only known Elite items of that entry's reward kind are classified. Its featured
ID is a featured reward; another known Elite of the same kind recorded in that
pool is an off-banner reward. This does not infer a pool's entire eligible roster.
When no dated mapping matches, targeted recruitment instead uses the fixed
standard Elite loss roster. A known Elite in that roster is off-banner; another
known Elite of the matching kind is featured. Lower-rarity pulls carry state
without requiring a dated banner entry. The roster includes Faye/Hestia and
Harpsy/Antinomy; membership does not assert availability before introduction.

A dated mapping takes precedence, including banners featuring standard items.
Fallback is suppressed for pool IDs known to feature a standard item when their
dates do not match. Unknown catalog items, mismatched kinds and ambiguous
fallback rosters remain unknown.
Imported `wonStatus` or `isFirstGuarantee` annotations are not treated as evidence.

The initial reviewed catalog contains 110 mappings for Targeted Procurement
(type 3) and Military Upgrade (type 4), covering December 2024 through early
April 2026. Only the Sunborn US host is enabled. Other providers and selected/custom recruitment require reviewed metadata and rules before enabling them.
The same numeric pool ID can be reused for a different reward in another year.

Published metadata and publisher event notices have different clock conventions.
The initial catalog therefore excludes 24 hours at each event boundary. These
are conservative matching guards, not exact event schedules. Boundary records and newer events can use the fixed loss roster, except for
standard-item rate-up exceptions; unknowns must never be shown as zero losses,
zero featured rewards, or a complete win rate.

`scripts/update_banner_rules.py` reproduces the factual mappings from a pinned
public bundle without executing it. A different content hash fails validation;
updating the pin requires reviewing provider scope, time conventions, reused IDs,
and featured IDs. The updater preserves separately reviewed fixed-loss facts;
roster changes require their own review and a rules-version bump. See [data provenance](../THIRD_PARTY_NOTICES.md#banner-classification-facts).

## Derivation

Each recruitment family has independent state. Source timestamp order is newest
first, including equal-time multi-pulls; analysis walks the opposite direction.
Guarantee state carries across classified pools of the same family. Initial guarantee
is unknown, even if launch-day pity is assumed known by the existing pity model.

- An off-banner Elite proves a non-guaranteed loss and guarantees the next Elite.
- A featured Elite after a known loss is guaranteed, not a rate-up win.
- A featured Elite with known non-guaranteed state is a win.
- A featured Elite with unknown prior state has known featured identity but an
  unknown win/guarantee outcome. It establishes non-guaranteed state afterward.
- A gap, unknown reward rarity/kind, or pool without an applicable rule invalidates affected state.
- An off-banner result after a known guarantee is flagged `guarantee_conflict`;
  it is not counted as another loss. The result still establishes the next
  guarantee, but invalidates the featured interval across the conflict.

`featured_pity` counts individual records between known featured rewards,
including intervening off-banner and lower-rarity rewards. The first featured
interval, disconnected intervals, and intervals crossing unclassified evidence
are null. Item quantities do not multiply pull counts.

## Query contract

`banner_result` includes `featured` (true/false/null), `outcome` (win, loss,
guaranteed, unknown, or not_applicable), nullable `guarantee_before` and
`guarantee_after`, nullable `featured_pity`, and a machine-readable `reason`.
Unsupported recruitment types use `not_applicable`; lower-rarity rows carry
state without being included as Elite outcomes.

The rewards response adds `featured`: featured/off-banner counts, known wins,
losses and guarantees, unknown identity/outcome counts, complete featured
intervals, and nullable current guarantee. The summary always describes the
entire selected recruitment family, even when the displayed page is filtered.
A known-subset rate can use `wins / (wins + losses)` but must retain unknown
counts and disclose incomplete coverage. Do not call this a lifetime win rate.

## Validation

Synthetic tests cover identical timestamps, loss/guarantee/win transitions,
unknown starts, pool changes, type separation, gaps, unknown items/providers,
reused pool IDs, ambiguous dates, contradictions, and filtering/pagination.
`web/tests/banner-parity.json` is shared by browser and Python tests. Test fixtures
contain no private history. A production archive can be inspected read-only;
its original records and source annotations are never rewritten by derivation.
