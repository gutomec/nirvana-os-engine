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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "./bun-helpers.ts";

/** The field the stamp lives in. Short, so it does not dominate a log line. */
export const STAMP_FIELD = "sig";

/** Where the per-install key lives. Never inside a project, never in a pack.
 *
 *  `NIRVANA_AUDIT_KEY` overrides it, and is read on every call rather than once:
 *  `paths` memoizes, so a test that redirected `NIRVANA_HOME` would only win if
 *  it were the first thing in the process to touch it — and a test that has to
 *  win a race writes a key into the owner's real home when it loses. */
export function auditKeyPath(): string {
  return process.env.NIRVANA_AUDIT_KEY || path.join(paths.NIRVANA_HOME, ".nirvana", "audit-key");
}

let cached: Buffer | null = null;
let cachedFrom = "";

/**
 * The install's signing key, created on first use.
 *
 * Unreadable or uncreatable (a read-only home, a sandbox) returns null rather
 * than throwing: an engine that cannot sign must still run and still log. The
 * events come out unstamped, a reader reports them as unverified, and nothing
 * pretends otherwise.
 */
export function auditKey(): Buffer | null {
  const p = auditKeyPath();
  if (cached && cachedFrom === p) return cached;
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8").trim();
      if (raw.length >= 32) { cached = Buffer.from(raw, "hex"); cachedFrom = p; return cached; }
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString("hex"), { mode: 0o600 });
    cached = key; cachedFrom = p;
    return cached;
  } catch { return null; }
}

/** Test seam: forget the cached key so a fixture can point at its own home. */
export function resetAuditKeyCache(): void { cached = null; cachedFrom = ""; }

/**
 * The bytes that get signed: the event minus its own stamp, with keys sorted.
 *
 * Sorted because `JSON.stringify` preserves insertion order, and an emitter that
 * builds the same event with its keys in a different order would produce a
 * different MAC for identical content — a false "tampered" on honest data.
 */
function canonical(event: Record<string, any>): string {
  const { [STAMP_FIELD]: _drop, ...rest } = event;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** Add the stamp. Returns the event unchanged when there is no key to sign with. */
export function stamp<T extends Record<string, any>>(event: T): T {
  const key = auditKey();
  if (!key) return event;
  const sig = crypto.createHmac("sha256", key).update(canonical(event)).digest("hex").slice(0, 32);
  return { ...event, [STAMP_FIELD]: sig };
}

export type Provenance = "engine" | "unsigned" | "tampered";

/**
 * Who wrote this event.
 *
 *  - `engine`    — signed, and the signature matches its own content.
 *  - `unsigned`  — no stamp. Either a narrator, or an engine that could not
 *                  reach its key, or a line written before this existed. All
 *                  three mean the same thing to a reader: not evidence.
 *  - `tampered`  — stamped, but the content does not match the stamp. Someone
 *                  edited a real event, which is worse than writing a fake one.
 */
export function provenanceOf(event: Record<string, any>): Provenance {
  const sig = event?.[STAMP_FIELD];
  if (typeof sig !== "string" || !sig) return "unsigned";
  const key = auditKey();
  if (!key) return "unsigned";
  const expect = crypto.createHmac("sha256", key).update(canonical(event)).digest("hex").slice(0, 32);
  // Length-safe compare; a mismatch here is a finding, not an error.
  const a = Buffer.from(sig), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? "engine" : "tampered";
}

/** Count a file's events by provenance — what a reader needs before trusting it. */
export function auditProvenanceSummary(file: string): { engine: number; unsigned: number; tampered: number; total: number } {
  const out = { engine: 0, unsigned: 0, tampered: 0, total: 0 };
  let lines: string[];
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return out; }
  for (const l of lines) {
    let e: any;
    try { e = JSON.parse(l); } catch { continue; }
    out.total++;
    out[provenanceOf(e)]++;
  }
  return out;
}
