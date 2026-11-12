// brief-altitude.ts — what the brief's shape changes in the instructions the
// engine gives a worker.
//
// `briefing.altitude` (outcome, guided, prescriptive) was the setting for that
// shape. The brief templates replaced it (lib/brief-templates.ts,
// `briefing.template`); the altitude is now a legacy alias that selects a
// template while `briefing.template` is unset. What it still decides is the
// worker's sentence on method and the delivery check's strictness: the
// detailed template, or a stored prescriptive, reads as prescriptive; a stored
// guided as guided; everything else as outcome, where each surface here
// returns nothing.

import type { ResolveOptions } from "../../_shared/lib/settings.ts";
import { resolveActiveTemplate } from "./brief-templates.ts";

export const BRIEF_ALTITUDES = ["outcome", "guided", "prescriptive"] as const;
export type BriefAltitude = (typeof BRIEF_ALTITUDES)[number];

/** The effective altitude and where it came from (the active template). A
 *  broken settings file never stops a dispatch: it falls back to outcome. */
export function resolveBriefAltitude(opts: ResolveOptions = {}): { altitude: BriefAltitude; source: string } {
  try {
    const active = resolveActiveTemplate(opts);
    return { altitude: active.altitude, source: `template ${active.name} (${active.source})` };
  } catch {
    return { altitude: "outcome", source: "default" };
  }
}

export function briefAltitude(opts: ResolveOptions = {}): BriefAltitude {
  return resolveBriefAltitude(opts).altitude;
}

/** One line on what a brief at this altitude carries, for the orchestrator. */
export function altitudeSummary(altitude: BriefAltitude): string {
  switch (altitude) {
    case "guided":
      return "guided: the result, the guardrails and \"Done when\", plus the structure you suggest in \"Suggested structure\" (sections, order, outline); the worker may adapt it and says why.";
    case "prescriptive":
      return "prescriptive: one \"Done when\" criterion per item, every artifact named in \"Output\" (file and format), and the method in \"Method\"; the worker follows them.";
    default:
      return "outcome: the result, the guardrails and \"Done when\"; method, depth and artifact layout are the worker's.";
  }
}

/** The sentence a worker prompt adds about the brief, or "" at outcome. */
export function altitudeWorkerLine(altitude: BriefAltitude): string {
  if (altitude === "guided") {
    return "The brief is guided: follow the structure it suggests (\"Suggested structure\") unless the work calls for a better one, and say in the summary where you departed from it and why.";
  }
  if (altitude === "prescriptive") {
    return "The brief is prescriptive: deliver exactly the artifacts its \"Output\" (or \"Deliver\") lists, meet every \"Done when\" criterion item by item, and follow the method it states (\"Method\"); where it states none, the method is yours.";
  }
  return "";
}

/** The squad prompt's sentence on method: the historical one at outcome. */
export function altitudeMethodSentence(altitude: BriefAltitude): string {
  if (altitude === "guided") return "Method and tools are yours; follow the structure the brief suggests unless the work calls for a better one, and say why in your summary.";
  if (altitude === "prescriptive") return "Follow the method and the artifact list the brief states, item by item; where it states none, method and tools are yours.";
  return "Method and tools are yours.";
}

/** The instruction an enrichment pass adds about the shape of what it writes, or "" at outcome. */
export function altitudeEnrichmentLine(altitude: BriefAltitude): string {
  if (altitude === "guided") {
    return "Altitude guided: besides the result, guardrails and definition of done, add a 'Suggested structure' block with the structure you suggest (sections, order, outline).";
  }
  if (altitude === "prescriptive") {
    return "Altitude prescriptive: state one acceptance criterion per item, list every artifact (file name and format) the client receives, and add a 'Method' block with the method the work follows.";
  }
  return "";
}
