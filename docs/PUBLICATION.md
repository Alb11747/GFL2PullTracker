# Preparing an open-source copy

## Prepare the repository copy

Keep personal deployment tools, machine configuration, private contact details,
and recovery artifacts outside the public repository. Review the entire history
to be published, including commit messages and author/committer metadata.
Use public attribution and a noreply address without changing other contributors'
identities. Preserve a verified recovery bundle locally before rewriting history.

Create a separate copy of the intended branch without tags, hardlinks, or internal
refs. Do not export uncommitted files, ignored files, or private recovery branches.
Inspect the copy's refs, commit metadata, and final tree before adding a remote.
Run the documented project checks, a redacted full-history secret scan, and Git
object integrity checks. Keep scan reports outside the tracked tree. A nonzero
scan result blocks publication; review findings before changing any scanner rules.
Verify downloaded scanner binaries against their official release checksums.

For a first publication, run GitHub CI in a private staging repository before
making it public. Publishing source does not deploy the application or establish
that its runtime release gates have passed.

MIT covers this project's original code. Preserve `THIRD_PARTY_NOTICES.md`, the
font license, and game-data provenance. Game names and other third-party content
do not acquire an MIT license through inclusion here.
