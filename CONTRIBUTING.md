# Contributing

Use Python 3.11 or later, uv, and Node.js 24. Install the locked dependencies with
`uv sync --frozen` and `npm --prefix web ci`. Run `uv run --frozen pytest`,
`npm --prefix web run check`, `npm --prefix web test`, and `npm --prefix web run build`.

Keep synthetic fixtures free of real credentials and player histories. Preserve
occurrence multiplicity, account identity boundaries, source ordering, coverage
gaps, and the distinction between uploaded and server-fetched history. The
supported archive baseline is version 1 for portable state, gzip backups, and
Drive revision metadata. Stable browser and Drive storage use separate namespaces
that preserve discarded prerelease archives without migrating them. Do not add
legacy readers for those formats. Future supported schema changes require explicit,
tested migrations from version 1, integrity checks, atomic failure, recovery copies,
and a documented rollback boundary. See the
[format and rollback contract](docs/GOOGLE_DRIVE.md#stable-archive-version-1) and
[release checklist](docs/PUBLICATION.md#first-public-release-checklist).
Collector and Exilium import versions are independent and remain validated.

Do not add production captures to issues or test fixtures. Reproduce problems
with synthetic data. Follow [SECURITY.md](SECURITY.md) for vulnerabilities and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for catalog and font provenance.
Original contributions are licensed under the project MIT license; that license
does not grant rights over third-party game content.
