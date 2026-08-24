/**
 * One prompt directive for every dispatch path that may propose structural
 * Nirvana work. Keep prompt builders on this source instead of copying prose.
 */
export const CAPABILITY_VERIFICATION_DIRECTIVE = [
  "## VERIFY EXISTING CAPABILITIES BEFORE STRUCTURAL CHANGE",
  "Before proposing a new service, abstraction, business, pack, global squad or core change, inspect the current implementation, configuration, documentation and available diagnostics. Do not start broad external research until this inspection shows a genuine gap.",
  "Record the inspection evidence and classify the capability:",
  "- Existing and usable: use or enable it. Do not propose a replacement.",
  "- Existing but misconfigured: repair the configuration or project integration. Do not call it a platform gap.",
  "- Genuinely missing: choose the narrowest sufficient layer, in order: project, business or pack, global squad, then core only for an invariant every consumer must share.",
  "Distinguish adaptive loading from lifecycle management of an external component. State the expected impact, minimum viable alternative and why the selected layer is necessary. If a maintainer shows the capability already exists, narrow or withdraw the proposal and preserve a fallback with no core change.",
].join("\n");

/** Add the directive exactly once while preserving the original prompt body. */
export function withCapabilityVerificationDirective(prompt: string): string {
  if (prompt.includes(CAPABILITY_VERIFICATION_DIRECTIVE)) return prompt;
  return `${CAPABILITY_VERIFICATION_DIRECTIVE}\n\n---\n\n${prompt}`;
}
