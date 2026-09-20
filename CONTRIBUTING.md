# Contributing

Use Python 3.11 or later, uv, and Node.js 24. Install the locked dependencies with
`uv sync --frozen` and `npm --prefix web ci`. Run `uv run --frozen pytest`,
`npm --prefix web run check`, `npm --prefix web test`, and `npm --prefix web run build`.

Keep synthetic fixtures free of real credentials and player histories. Preserve
occurrence multiplicity, account identity boundaries, source ordering, coverage
gaps, and the distinction between uploaded and server-fetched history. Changes
to archive versions need explicit compatibility handling and migration tests.

Do not add production captures to issues or test fixtures. Reproduce problems
with synthetic data. Follow [SECURITY.md](SECURITY.md) for vulnerabilities and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for catalog and font provenance.
Original contributions are licensed under the project MIT license; that license
does not grant rights over third-party game content.
