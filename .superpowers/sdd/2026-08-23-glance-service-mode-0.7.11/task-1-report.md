# Task 1 report: Glance service state foundations

## Scope

Implemented only Task 1 on `feat/glance-service-mode` from base `aa7996bf62a127825edf6aa6ed14fa2fef6212b8`.

Added exact extracted schemas, closed validators, strict JSON parsing, contained service-reference resolution, private durable writes, permission checks, and strict state reads. No CLI, server, manager, worker, lock, control, serve, version, changelog, or shared-lock surfaces were changed.

## Preflight

- Confirmed `origin/main`, HEAD, package version, and skills version against the Task 1 base.
- Confirmed the specification SHA-256: `d168be91f4df700336f811df3fee479e8b7bd276e5fe4ba22a6802c014480e74`.
- Confirmed all extracted schema SHA-256 values:
  - Config: `e021b6adeca2961a58858e1861aa2f543d8e85b3b3d0efe9b3c631afefa4859f`
  - Instance: `fd064b5d502529fc59f48a1e8bbabc7db4681e22f5aa5a114aa17f748f940fa1`
  - Lock owner: `e2fe66b4050988746325085c19598cda4b1a1e6daab03324003aa0cb7e25de8f`
  - Stop request: `e4b437fb21be9a2266bee175f97579c606e707861eb0b821e4b8f793ba1eb4d3`

## RED/GREEN evidence

1. The initial focused test suite failed with the expected module-resolution error because the service implementation did not exist.
2. The schema-extractor argument test then failed with exit `1` because the extractor was absent; it passed with exit `2` after the implementation.
3. The first durable-write GREEN exposed a real Windows ACL parsing failure, followed by an `EPERM` parent-directory `fsync` failure. The final implementation retains the directory fsync attempt and accepts only Windows' unsupported-directory-flush errors (`EPERM`, `EINVAL`, `EBADF`); POSIX failures remain fatal. ACL checks allow only the current user plus platform-localized SYSTEM/logon-session principals and reject foreign principals.
4. Final focused result: `55 pass`, `0 fail`, `56 expect() calls`.

## Commands and results

- `bun test .\skills\harness\tests\glance-service-state.test.ts` — pass, 55 tests.
- `git diff --check` — pass.
- `git diff --cached --check` — pass.
- SHA-256 verification of the four schema files — all matched the binding hashes.

An attempted external temporary-directory extractor composition probe was rejected by the terminal policy before it executed because its cleanup command was classified as destructive. It produced no temporary directory or repository residue.

## Files

- `scripts/extract-glance-service-schemas.ts`
- `skills/harness/lib/glance/service/{types,strict-json,schema-validator,paths,permissions,state}.ts`
- `skills/harness/lib/glance/service/schemas/*.json`
- `skills/harness/tests/glance-service-state.test.ts`

## Workspace incident and cleanup

The first `apply_patch` invocation defaulted to the shared workspace root rather than the assigned worktree and created only `C:\Users\aalme\OneDrive\Projetos\Nirvana-Dev\skills\harness\tests\glance-service-state.test.ts`. It was created in this task, removed with `apply_patch Delete File`, and its absence was verified before the tests and production files were reapplied using absolute worktree paths. No other root-workspace file was touched.

## Self-review and concerns

- All changed source/test/schema files are confined to Task 1 surfaces.
- No shell-string subprocess, Node/npm/npx/tsx, dependency installation, elevated action, service launch, browser launch, remote binding, or later-task surface was used.
- Windows parent-directory durability is subject to the documented platform limitation: the flush is attempted, while the three known unsupported codes are tolerated only on Windows.
- Implementation commit: `2d9cae974ee6ff6b06c8e67e210f65d5e3f15278` (`feat(glance): add service state foundations`).
