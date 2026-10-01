<!-- nirvana-os:on-demand-contract:v3 -->
## Nirvana-OS: installed, out of the way

Work as you would without it. Answer, write, code and build with your own
tools; Nirvana-OS does nothing here unless the request calls for it.

The request calls for it when it:
- names it ("use o Nirvana", "via nirvana-os", "use Nirvana to …");
- names or points to one of the user's businesses, squads or mind-clones, by
  name, by kind or as the model to follow ("use minha empresa de lançamentos",
  "o squad de copy", "com a voz do Hormozi",
  "como a empresa X e seus squads e clones"), including a pack or product name
  that is not an exact slug;
- asks for the work, or a part of it, to run on another agent runtime
  ("use o codex para revisar", "rode no agy").

Then the work is Nirvana's: invoke the `nirvana` skill with the user's words
verbatim (a runtime that reads files instead reads
`~/.nirvana/skills/harness/SKILL.md` and follows it) and do not build the
deliverable yourself, even when a search finds no exact match. Questions about
the library are lookups: `nrv list-businesses`, `nrv list-squads`,
`nrv list-clones`.

If `NIRVANA_DISPATCH_DEPTH` is set, Nirvana dispatched you: do the work in your
brief yourself and never invoke Nirvana again.
