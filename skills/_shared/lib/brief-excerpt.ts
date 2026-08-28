// brief-excerpt.ts — typed ESM face of brief-excerpt.js.
//
// The implementation moved to the CJS sibling so cloudevents.js can
// `require()` it without crossing the ESM boundary that only Windows'
// Bun enforces as a hard error (require() of an ESM module throws
// "require() async module" there, and tolerates it on macOS/ubuntu). This
// file re-exports the same two values, typed, for the many ESM importers
// that already reference `brief-excerpt.ts` by that path — an ESM `import`
// of a CJS module never crosses the broken boundary, on any platform.

import * as impl from "./brief-excerpt.js";

/** Hard ceiling, in characters, for any brief text on an audit event. */
export const BRIEF_EXCERPT_MAX: number = impl.BRIEF_EXCERPT_MAX;

/**
 * The bounded, single-line form of a brief.
 *
 * Returns `null` when there is nothing to show — absence, which a reader renders
 * as `—`, is not the same as an empty string it would render as blank.
 */
export const briefExcerpt: (brief: unknown, max?: number) => string | null = impl.briefExcerpt;
