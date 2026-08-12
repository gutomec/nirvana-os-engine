# Security policy

## Reporting a vulnerability

Report privately via **GitHub Security Advisories**: on this repository, go to
*Security → Report a vulnerability*. Do not open a public issue for anything
exploitable.

You can expect an acknowledgment within 7 days. There is no bug bounty; fixes
credit the reporter in the changelog unless anonymity is requested.

## Scope

The engine in this repository: the `nrv` CLI, the harness orchestrator, the
installers (`install.sh` / `install.ps1` / `scripts/install.ts`), the update and
license flows, and the release pipeline.

Of particular interest, given what this software does:

- Prompt-injection paths: content that reaches an agent's context (briefs,
  manifests, skill files) steering it to exfiltrate or destroy data.
- The dispatch/audit chain: forging `gate_passed`/`delivered` events, or making
  the supervisor act on runs it does not own.
- Install/update integrity: anything that lets a tampered tarball or pack pass
  verification.

Paid pack content and the commerce backend (squads.sh) are out of scope here —
report those privately to the same advisory channel and they will be routed.
