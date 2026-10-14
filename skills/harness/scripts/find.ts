#!/usr/bin/env bun
/**
 * find.ts — the orchestrator's shortlist: who could deliver a request, zero tokens.
 *
 * The orchestrator decides; this prints what it decides between. It used to
 * print the router's own verdict with five mixed alternatives and no
 * description, a business route showing as the seat it routes to: measured on
 * 48 labeled requests (2026-10-13), the right business was in that list for 78%
 * of the parts. Ranked apart, businesses and squads put the right business in
 * the first five for 95% of them, so each kind gets its own list, and each line
 * says what the entity produces, what it is and what it refuses.
 *
 *   nrv find "<request>"            the shortlist
 *   nrv find "<request>" --json     the router's full decision (unchanged), plus `shortlist`
 *   nrv find "<request>" --amplify  let the router amplify a short brief first (one model call)
 *   nrv find "<request>" --jev      TypeSafe's Jev suggestion above the list (one TypeSafe call;
 *                                   only with a TYPESAFE_API_KEY and routing.jev on). Off by
 *                                   default: its effect on the orchestrator was never measured.
 */

import * as path from "node:path";
import { createRequire } from "node:module";
import { EXIT } from "../../_shared/lib/bun-helpers.ts";
import { preflightReindex } from "../lib/preflight-index.ts";
import { rankShortlist, shortlist, SHORTLIST_SIZE, type Shortlist } from "../lib/shortlist.ts";
import type { JevRouteResult } from "../lib/jev-router.ts";

export { rankShortlist, shortlist, SHORTLIST_SIZE, type Shortlist };

const require_ = createRequire(import.meta.url);
const router = require_(path.join(import.meta.dir, "..", "lib", "router.js"));
const loader = require_(path.join(import.meta.dir, "..", "lib", "registry-loader.js"));

export function renderShortlist(brief: string, s: Shortlist): string {
  const out: string[] = [`request: ${brief}`, ""];
  if (s.named) out.push(`named in the request: ${s.named.kind} ${s.named.slug} — it is the target`, "");
  out.push("businesses (best first):");
  s.businesses.forEach((b, i) => out.push(`  ${i + 1}. ${b.card}`));
  if (!s.businesses.length) out.push("  (none matched)");
  out.push("", "squads (best first, with the capability that matched):");
  s.squads.forEach((q, i) => out.push(`  ${i + 1}. ${q.card}${q.capability ? ` | capability: ${q.capability}` : ""}`));
  if (!s.squads.length) out.push("  (none matched)");
  const c = s.clones;
  if (c.named.length || c.ambiguous.length || c.missing.length) {
    out.push("", "clones the request names:");
    for (const slug of c.named) out.push(`  - ${slug}`);
    for (const a of c.ambiguous) out.push(`  - "${a.name}" is more than one clone: ${a.candidates.join(", ")} (ask which)`);
    for (const m of c.missing) out.push(`  - "${m}" is not in the library`);
  }
  out.push("", "A ranking by words, not a decision: read the finalists (`nrv cards squad <slug>`, the business's business.yaml), then decide.",
    "Nothing fits? `nrv list-businesses` shows the whole library.");
  return out.join("\n");
}

/** The Jev's suggestion, as the lines printed above the shortlist. */
export function renderJev(r: JevRouteResult): string {
  const d = r.decision;
  const targets = d.parts?.length ? d.parts.map((p) => `${p.kind} ${p.slug}`).join(" + ")
    : d.kind === "no_match" ? "nothing in the library (the generalist)"
    : d.primary_business ? `business ${d.primary_business}` : `squad ${d.mandatory_squads[0]}`;
  const trust = r.confidence >= r.gate
    ? `confidence ${r.confidence.toFixed(2)}: at or above ${r.gate}, where every measured suggestion was right`
    : `confidence ${r.confidence.toFixed(2)}: below ${r.gate}, a guess; decide from the cards`;
  return [
    `Jev (a classifier, not a decision) suggests: ${targets}${d.parts?.length ? ` (${d.parts.length} parts)` : ""}`,
    `  ${trust}`,
    ...(d.suggested_mind_clones.length ? [`  voice: ${d.suggested_mind_clones.join(", ")}`] : []),
    "",
  ].join("\n");
}

export interface FindArgs {
  brief: string;
  json: boolean;
  /** Ask the Jev too (needs the key and routing.jev on). */
  jev: boolean;
  /** Options for the router's decision under --json, as `lib/router.js find` read them. */
  route: { amplify: boolean; forceAmplify: boolean; prefer?: string; preferAmplifier?: string; disableStageMinus1: boolean };
}

/**
 * The flags `nrv find` accepted when it forwarded to `lib/router.js find`
 * (`--no-amplify`, `--prefer <x>`, `--force-amplify`, `--prefer-amplifier <x>`,
 * `--no-stage-minus-1`) are still read, never left in the request text, where
 * they became search words. No amplification unless asked.
 */
export function parseFindArgs(raw: string[]): FindArgs {
  const valued = new Set(["--prefer", "--prefer-amplifier"]);
  const value = (name: string) => { const i = raw.indexOf(name); return i >= 0 ? raw[i + 1] : undefined; };
  const words = raw.filter((a, i) => !a.startsWith("--") && !(i > 0 && valued.has(raw[i - 1])));
  const prefer = value("--prefer");
  const preferAmplifier = value("--prefer-amplifier");
  return {
    brief: words.join(" ").trim(),
    json: raw.includes("--json"),
    jev: raw.includes("--jev"),
    route: {
      amplify: raw.includes("--amplify") && !raw.includes("--no-amplify"),
      forceAmplify: raw.includes("--force-amplify"),
      ...(prefer && ["business", "squad", "auto"].includes(prefer) ? { prefer } : {}),
      ...(preferAmplifier && ["builtin", "maestro"].includes(preferAmplifier) ? { preferAmplifier } : {}),
      disableStageMinus1: raw.includes("--no-stage-minus-1"),
    },
  };
}

if (import.meta.main) {
  const raw = process.argv.slice(2);
  if (raw.length === 0) {
    console.error("usage: find <brief> [--json] [--amplify]");
    process.exit(EXIT.INVALID_ARGS);
  }
  const args = parseFindArgs(raw);
  const wantJson = args.json;
  const brief = args.brief;
  if (!brief) {
    console.error("find: brief is empty");
    process.exit(EXIT.INVALID_ARGS);
  }
  // Never rank against a stale corpus (routing-360 Phase 2.5); <50ms when fresh.
  preflightReindex();
  const registries = loader.loadAll();
  const list = await shortlist(brief, registries);
  let jev: JevRouteResult | null = null;
  let jevNote = "";
  if (args.jev) {
    // Loaded only when asked: the plain command stays one BM25 pass.
    const { jevDoctorLine, jevEnabled } = await import("../../_shared/lib/typesafe-client.ts");
    if (jevEnabled()) {
      const { jevRoute } = await import("../lib/jev-router.ts");
      try { jev = await jevRoute({ brief, registries }); } catch { jev = null; }
      if (!jev || (!jev.call.ok && !jev.named)) { jevNote = "jev: no answer (the call failed); the shortlist stands alone\n\n"; jev = null; }
    } else jevNote = `${jevDoctorLine()}\n\n`;
  }
  if (wantJson) {
    // The router's decision as before, for whoever parses it, with the shortlist beside it.
    // No amplification unless asked: an orchestrator already understood the request.
    const decision = await router.route(brief, { registries, ...args.route });
    const jevJson = jev ? { jev: { decision: jev.decision, confidence: jev.confidence, gate: jev.gate, escalate: jev.escalate, latency_ms: jev.call.latency_ms } } : {};
    process.stdout.write(JSON.stringify({ ...decision, shortlist: list, ...jevJson }, null, 2) + "\n");
  } else {
    process.stdout.write((jev ? renderJev(jev) : jevNote) + renderShortlist(brief, list) + "\n");
  }
  process.exit(EXIT.OK);
}
