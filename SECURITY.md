# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.4.x   | yes |
| 0.3.x   | no — please upgrade |
| < 0.3   | no |

## Reporting a vulnerability

**Do not open a public GitHub issue.** Email **sebastien.denes@sap.com** directly with:

- A description of the issue and the impact you observed
- A minimal reproduction (sample input, repo URL, or stack trace)
- The Halo version affected (`cgrca version`) and your environment (Node version, OS, MCP client)
- Any suggested mitigation, if you have one

You'll get an acknowledgement within seven days. We follow a 90-day coordinated-disclosure window: the report stays embargoed until either a fix ships or 90 days pass, whichever is sooner. Credit is given in the release notes unless you prefer to remain anonymous.

## In scope

- Arbitrary code execution via maliciously-crafted source code at the tree-sitter parser stage
- MCP server transport (stdio + JSON-RPC framing)
- GitHub-App webhook handler signature validation (`/webhook`, `/sentry`, `/incident`)
- Daemon unix socket and lockfile handling at `~/.cgrca/daemon.sock` / `~/.cgrca/daemon.lock`
- Path-traversal in the source-excerpt API (`/api/session/:id/source/*`)
- SQL injection via persisted sqlite reuse

## Out of scope

- Anything under `_design/` (mockups + design exploration archive)
- Test fixtures
- Vulnerabilities in transitive npm dependencies — please report those upstream
- Misconfigured deployments of the GitHub-App (env vars, hosting setup)

Thanks for helping keep Halo safe.
