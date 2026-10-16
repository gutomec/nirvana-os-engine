#!/usr/bin/env bun
// brief-proxy.ts — the "informed client" briefing proxy.
//
// Phase 2 of the autopilot. Where `--auto-brief` (deterministic) appends
// templated assumptions, the proxy runs a real LLM pass that plays an informed
// client / intake analyst: it surfaces the clarifying questions a human would
// be asked, ANSWERS them on the absent human's behalf using conservative
// industry defaults, and returns an enriched brief. This is the "agent that
// decides the briefing for the human" the autopilot needs to stay one-command.
//
// It runs headless with NO tools (pure text in, enriched brief out), so it is
// cheap and cannot touch the filesystem. The main employee dispatch then runs
// against the enriched brief.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless, runtimeAvailable, type Runtime } from "./host-agent-driver.ts";
import { resolveRunRuntime } from "./runtime-rules.ts";
import { altitudeEnrichmentLine, briefAltitude, type BriefAltitude } from "./brief-altitude.ts";
import { resolveActiveTemplate } from "./brief-templates.ts";
import { parseWorkBrief, skeletonWithRequest } from "./work-brief.ts";

const BUSINESSES_ROOT = path.join(os.homedir(), "businesses");

function businessContext(slug: string): string {
  const yml = path.join(BUSINESSES_ROOT, slug, "business.yaml");
  if (!fs.existsSync(yml)) return `(business '${slug}' — no local manifest)`;
  const text = fs.readFileSync(yml, "utf8");
  // Keep it short: name, description, domains lines only.
  const keep = text.split("\n").filter(l => /^(name|description|domains|industry|sector|owner):/.test(l.trim()) || /^\s+-\s/.test(l)).slice(0, 20);
  return keep.join("\n") || `(business '${slug}')`;
}

/** The template the enriched brief follows, and the file with the client's words. */
export interface ProxyShape {
  /** The active brief template: its name and its whole text. */
  template: { name: string; text: string; skeleton: string; format: "labels" | "sections" };
  /** Where the client's words are kept; the brief's Request names it. */
  requestPath: string;
}

/** The enrichment prompt. With a template, the enriched brief is written in it
 *  (the active brief template); without one, `briefing.altitude` adds one
 *  instruction on its shape and at outcome the prompt is the historical one. */
export function proxyPrompt(brief: string, slug: string, ctx: string, altitude: BriefAltitude = "outcome", shapeOf?: ProxyShape): string {
  if (shapeOf) {
    const skeleton = skeletonWithRequest(shapeOf.template.skeleton, shapeOf.requestPath).trimEnd();
    return [
      `You are an experienced intake analyst for the business "${slug}". Business context:`,
      "",
      ctx,
      "",
      `You received the briefing below from a client who is NOT available to answer questions. The client's own words are kept, verbatim, in ${shapeOf.requestPath}.`,
      "",
      "<<<BRIEFING>>>",
      brief,
      "<<<END>>>",
      "",
      "Your task (decide on behalf of the absent client):",
      "1. List mentally the clarifying questions a professional intake would ask for this briefing in this business.",
      "2. Answer EACH one yourself, with conservative, market-standard assumptions (you decide in place of the absent human).",
      `3. Write ONE brief, in the language of the briefing, following the brief template "${shapeOf.template.name}" below: its labels exactly, its skeleton filled in. Put each assumption you decided under Decisions, ending it in "(assumed)".`,
      `4. ${shapeOf.template.format === "labels" ? `Keep the line "Request: ${shapeOf.requestPath}" as it is` : `Under the Request heading, write the path ${shapeOf.requestPath}`}: never retell the client's words.`,
      "",
      "<<<TEMPLATE>>>",
      shapeOf.template.text.trim(),
      "<<<END>>>",
      "",
      "The skeleton to fill:",
      "",
      skeleton,
      "",
      "Hyphen rule: use '-' only for compound words; never to join clauses or as a dash.",
      "Output: ONLY the text of the brief, with no meta commentary and no code fences.",
    ].join("\n");
  }
  const shape = altitudeEnrichmentLine(altitude);
  return [
    `You are an experienced intake analyst for the business "${slug}". Business context:`,
    "",
    ctx,
    "",
    "You received the briefing below from a client who is NOT available to answer questions:",
    "",
    "<<<BRIEFING>>>",
    brief,
    "<<<END>>>",
    "",
    "Your task (decide on behalf of the absent client):",
    "1. List mentally the clarifying questions a professional intake would ask for this briefing in this business.",
    "2. Answer EACH one yourself, with conservative, market-standard assumptions (you decide in place of the absent human).",
    "3. Produce ONE enriched briefing, in the language of the original briefing, that incorporates the original request plus your answers, ending with a section '## Assumptions decided by the proxy' listing what you assumed.",
    "",
    ...(shape ? [shape, ""] : []),
    "Hyphen rule: use '-' only for compound words; never to join clauses or as a dash.",
    "Output: ONLY the text of the enriched briefing, with no meta commentary and no code fences.",
  ].join("\n");
}

export interface ProxyResult {
  ok: boolean;
  enriched: string;
  raw: string;
  error?: string;
}

/** `runtime` is REQUIRED on purpose: it used to default to one vendor, so a
 *  caller that simply did not pass it enriched the brief on a CLI the user may
 *  never have signed into. The caller knows which session it is serving. */
export function proxyEnrichBrief(brief: string, slug: string, runtime: Runtime, opts: { maxBudgetUsd?: number; timeoutMs?: number; requestPath?: string } = {}): ProxyResult {
  if (!runtimeAvailable(runtime)) {
    return { ok: false, enriched: brief, raw: "", error: `runtime '${runtime}' unavailable` };
  }
  // The active brief template shapes the enriched brief when the client's
  // words have a file to live in; otherwise the historical prompt runs.
  const active = (() => { try { return resolveActiveTemplate(); } catch { return null; } })();
  const shapeOf: ProxyShape | undefined = active?.template && opts.requestPath
    ? { template: { name: active.name, text: active.template.text, skeleton: active.template.skeleton, format: active.template.format }, requestPath: opts.requestPath }
    : undefined;
  const prompt = proxyPrompt(brief, slug, businessContext(slug), briefAltitude(), shapeOf);

  const res = runHeadless({
    runtime,
    prompt,
    cwd: os.tmpdir(),
    allowedTools: [], // pure text — no filesystem
    permissionMode: "default",
    maxBudgetUsd: opts.maxBudgetUsd,
    timeoutMs: opts.timeoutMs ?? 8 * 60 * 1000,
  });

  let enriched = (res.result || "").trim();
  const floor = shapeOf ? 40 : brief.trim().length / 2;
  if (!res.ok || enriched.length < floor) {
    return { ok: false, enriched: brief, raw: res.result || "", error: res.error || "proxy returned too little" };
  }
  // A labelled brief must name the request: put the line back if the model dropped it.
  if (shapeOf?.template.format === "labels" && parseWorkBrief(enriched).sections.Request === undefined) {
    enriched = `Request: ${shapeOf.requestPath}\n${enriched}`;
  }
  return { ok: true, enriched, raw: res.result };
}

// CLI wrapper for standalone testing.
if (import.meta.main) {
  const [, , slug, ...rest] = process.argv;
  const brief = rest.filter(a => !a.startsWith("--")).join(" ");
  if (!slug || !brief) {
    console.error('Usage: bun brief-proxy.ts <business_slug> "<brief>" [--runtime=<name>]');
    process.exit(2);
  }
  const rtArg = process.argv.find(a => a.startsWith("--runtime="))?.split("=")[1] as Runtime | undefined;
  const out = proxyEnrichBrief(brief, slug, rtArg ?? resolveRunRuntime({ brief }).runtime);
  if (!out.ok) { console.error("proxy failed:", out.error); process.exit(1); }
  console.log(out.enriched);
}
