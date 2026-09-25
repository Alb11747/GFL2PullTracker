# Security policy

Do not post captures, game tokens, Google access tokens, account histories,
session cookies, or secret scanner findings in public issues.

When this repository is published, enable GitHub private vulnerability reporting
before accepting public users. Report vulnerabilities through its Security tab
using **Report a vulnerability**. If that option is unavailable, keep sensitive
details private and ask the maintainer to enable it; do not attach an exploit or
credential to a public issue.

Only the latest release receives security fixes. Operators should subscribe to
repository security advisories, run the CI dependency audits, and rebuild images
regularly. The shipped provider gate for history submission, recovery, and deletion
must stay closed until an audited adapter proves credential-to-account binding
from the actual provider response. Fresh authenticated capture proof binds access
to the actual UID, provider, server, and channel; there is no recovery key. A
successful request with a caller-supplied UID or decoded JWT payload is not
ownership proof. Verification of account ownership does not independently verify
the authenticity of uploaded pull records. Unified server history retains source
and fingerprint provenance and exposes only suppressed public aggregates.

Deployment configuration and recovery procedures are in
[docs/HOSTING.md](docs/HOSTING.md). The release audit covers Git history as well as
the final publication copy. A clean automated scan is evidence, not proof that
all sensitive material has been found.
