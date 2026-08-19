
<!-- nirvana-os:on-demand-contract:v1 -->
## Nirvana-OS — available on demand

Nirvana-OS is installed in this environment, in **on-demand mode**: it is NOT
the default orchestrator for this project. Do not route ordinary work through
it, and do not treat its protocols as this project's defaults.

Invoke it ONLY when the user explicitly asks — "use o Nirvana para X", "use
Nirvana to X", "dispatch this to a squad/business". On that request, invoke the
`harness` skill with the user's brief verbatim and let it orchestrate
(businesses → squads → quality gate → audit). Utility lookups on request:
`nrv list-squads`, `nrv list-businesses`, `nrv find-clone "<need>"`,
`nrv glance`.
