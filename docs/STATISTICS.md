# Personal statistics and real comparisons

Statistics has two views: Your statistics (default) and the existing community
ledger. My history retains its reward browsing interface. Personal summaries and
probability distributions run in browser workers; the page sends only comparison
aggregates to the read-only public comparison API. See PRIVACY.md for the data flow.

## History eligibility

Summary comparisons use the latest continuous stretch with a known starting
state, including unfinished current pity. Elite and featured windows are separate.
An observed reward can establish a missing starting state, but its cost and reward
are excluded from the new window. A gap never joins two stretches. Acquisition
charts instead use completed eligible intervals, including earlier valid stretches.
Rate-up wins count classifiable non-guaranteed attempts; guaranteed and unknown
outcomes remain separately reported. The shared classifier uses dated featured mappings first and the fixed standard
Elite loss roster for supported targeted banners without a mapping. Provider and
standard-item rate-up exceptions remain scoped (BANNER_OUTCOMES.md).

## Model and planning

The selected model is an assumption, not independently verified game documentation.
Dolls use base 0.6%, soft-pity parameter 59, hard pity 80 and 50% non-guaranteed featured
chance. Weapons use 0.7%, 51, 70 and 75%. The existing linear hazard remains unchanged.

Planning defaults to 75 additional pulls and featured rewards. It accepts 0–20,000
pulls, uses a conditional first wait from the displayed pity/guarantee, and then
normal renewal cycles. Unknown state is explicitly assumed rather than inferred.
The mean is a finite-budget expectation; the 5th–95th percentile range describes
discrete outcomes. Numerical limits and omitted-tail bounds remain visible.

## Server comparisons

`POST /api/public/statistics/compare` is a same-origin, rate-limited read accepting
only bounded matching dimensions and metric aggregates. It grants no account
access and does not save local history. Rules version, recruitment type, provider,
server, channel and relevant starting state must match. Each saved account supplies
at most one result: a prefix of its latest eligible window of the requested length,
or the requested number of earliest classifiable rate-up attempts. Short histories
are excluded. This is a voluntary sample, not a representative player leaderboard.

The response contains per-metric status and suppressed aggregate counts. Fewer
than 5 accounts are hidden; any nonempty comparison partition below 5 suppresses
numeric results. Counts alone are shown below 50. Owned accounts can be excluded
through a verified session; otherwise self-inclusion is disclosed. No provider
verification restriction is relaxed by this feature.

Comparison indexes are derived, rebuildable data. Source snapshots, normalized
pull order, browser archives and Drive backups are not replaced. Submissions,
deletions and classification revisions invalidate affected comparisons.
