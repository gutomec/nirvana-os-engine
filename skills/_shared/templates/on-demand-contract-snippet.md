<!-- nirvana-os:on-demand-contract:v2 -->
## Nirvana-OS: installed, out of the way

Work as you would without it. Answer, write, code and build with your own
tools; Nirvana-OS does nothing here unless the request calls for it.

Use it only when the user's request:
- names it ("use o Nirvana", "via nirvana-os", "use Nirvana to …");
- asks for one of their businesses, squads or mind-clones, by name or by kind
  ("use minha empresa de lançamentos", "o squad de copy", "com a voz do Hormozi");
- asks for the work, or a part of it, to run on another agent runtime
  ("use o codex para revisar", "rode no agy").

Then invoke the `nirvana` skill with the user's words verbatim; a runtime that
reads files instead reads `~/.nirvana/skills/harness/SKILL.md` and follows it.
Questions about the library are lookups: `nrv list-businesses`,
`nrv list-squads`, `nrv list-clones`.

If `NIRVANA_DISPATCH_DEPTH` is set, Nirvana dispatched you: do the work in your
brief yourself and never invoke Nirvana again.
