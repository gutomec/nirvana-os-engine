// audit-provenance.ts — telling an event the engine wrote from one an agent typed.
//
// The audit is the engine's evidence, and it is a text file any agent with Write
// can append to. On 2026-09-04 one did: a maestro wrote `dispatch_business`,
// `gate_passed` and an event name the engine has never emitted
// (`business_completed`) straight into a run's audit, with timestamps rounded to
// the minute and a JSON style the engine does not produce. The real pipeline ran
// too, minutes later — so the file ended up holding a self-issued verdict and a
// real one, and NOTHING in their shape told them apart.
//
// That is the defect this closes. Not "an agent can write to the file" — it can,
// and forbidding it would break the open `x_` namespace the protocol depends on.
// The defect is that a hand-written line is INDISTINGUISHABLE from an emitted
// one, which makes every count downstream (validate-chain, the receipt, the
// improver, `nrv baseline`) a count of claims rather than of events.
//
// The stamp is an HMAC over the event's own bytes, keyed by a secret that lives
// outside the audit. An emitter has the key; a narrator does not.
//
// ## What this does and does not buy
//
// It defeats CASUAL NARRATION — an agent writing plausible lines because it
// believes it should. That is the failure that actually happened, and it is the
// common one.
//
// It does NOT defeat a determined forger: anything running as the user can read
// `~/.nirvana/audit-key` and sign whatever it likes. Claiming otherwise would be
// the same species of dishonesty this file exists to detect. What it buys is
// that forging becomes a deliberate act — reading a key file and computing a MAC
// — instead of a side effect of an agent being helpful.
//
// The key is per-install, never travels in a pack, and is not a secret worth
// protecting beyond file permissions: it authenticates the writer to the reader
// on one machine. Losing it invalidates old stamps, which reads as "unverified",
// which is the honest answer after a key rotation.

// The implementation lives in the CJS sibling so `harness/lib/audit.js` — the
// canonical emitter, and CommonJS — can require() it without crossing the ESM
// boundary Windows enforces as a hard error. Mirrors log-paths.ts/.js.
import * as impl from "./audit-provenance.js";

export type Provenance = "engine" | "unsigned" | "tampered";

export const STAMP_FIELD: string = impl.STAMP_FIELD;
export const auditKeyPath: () => string = impl.auditKeyPath;
export const auditKey: () => Buffer | null = impl.auditKey;
export const resetAuditKeyCache: () => void = impl.resetAuditKeyCache;
export const stamp: <T extends Record<string, any>>(event: T) => T = impl.stamp;
export const provenanceOf: (event: Record<string, any>) => Provenance = impl.provenanceOf;
export const auditProvenanceSummary: (file: string) => { engine: number; unsigned: number; tampered: number; total: number } = impl.auditProvenanceSummary;
