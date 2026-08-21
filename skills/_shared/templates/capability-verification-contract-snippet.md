

---

<!-- nirvana-os:capability-verification-contract:v1 -->
### Verify before structural change

Before proposing a new service, abstraction, business, pack, global squad, or
core change, inspect the current implementation, configuration, documentation,
and available diagnostics. Do not start broad external research until this
inspection shows a genuine gap. Record what you inspected and classify the result:

- **Existing and usable:** use or enable it. Do not propose a replacement.
- **Existing but misconfigured:** fix configuration or the project-level
  integration. Do not call it a platform gap.
- **Genuinely missing:** choose the narrowest sufficient layer: project first,
  then business or pack, then global squad, and core only for an invariant that
  every consumer must share.

Do not confuse adaptive loading of businesses, squads, skills, or clones with
lifecycle management of an external component installed in the environment.
Before recommending structural work, provide evidence, expected impact, the
minimum viable alternative, and why the selected layer is necessary. If a
maintainer demonstrates that the capability already exists, narrow or withdraw
the proposal and preserve a fallback that requires no core change.
