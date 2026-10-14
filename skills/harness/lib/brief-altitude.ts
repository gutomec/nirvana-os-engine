// brief-altitude.ts — what `briefing.altitude` changes in a brief and in the
// instructions the engine gives a worker.
//
// The setting promised three shapes (settings-schema.ts): outcome = result,
// guardrails and definition of done (the default); guided = adds the structure
// the author suggests; prescriptive = per-item criteria, artifact list and
// method. Only the delivery check read it, so every value produced the same
// brief and the same worker prompt. Every surface that writes a brief or a
// dispatch instruction asks here. At `outcome` each one returns nothing, so the
// output is the one it was before the setting was read.

import { resolveSetting, type ResolveOptions } from "../../_shared/lib/settings.ts";

export const BRIEF_ALTITUDES = ["outcome", "guided", "prescriptive"] as const;
export type BriefAltitude = (typeof BRIEF_ALTITUDES)[number];

/** The active altitude, and where it came from. A broken settings file never
 *  stops a dispatch: it falls back to the default. */
export function resolveBriefAltitude(opts: ResolveOptions = {}): { altitude: BriefAltitude; source: string } {
  try {
    const r = resolveSetting("briefing.altitude", opts);
    const v = String(r.value ?? "outcome");
    return { altitude: (BRIEF_ALTITUDES as readonly string[]).includes(v) ? v as BriefAltitude : "outcome", source: String(r.source) };
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
      return "guided: the result, the guardrails and \"Done when\", plus the structure you suggest in \"## Suggested structure\" (sections, order, outline); the worker may adapt it and says why.";
    case "prescriptive":
      return "prescriptive: one \"Done when\" criterion per item, every artifact named in \"## Output\" (file and format), and the method in \"## Method\"; the worker follows them.";
    default:
      return "outcome: the result, the guardrails and \"Done when\"; method, depth and artifact layout are the worker's.";
  }
}

/** The sections the template adds above "## Done when" at this altitude. */
export function altitudeTemplateSections(altitude: BriefAltitude): string[] {
  if (altitude === "guided") {
    return ["## Suggested structure", "<the structure you suggest: sections, order, outline; the worker may adapt it>", ""];
  }
  if (altitude === "prescriptive") {
    return ["## Method", "<the method the work must follow, step by step where it matters>", ""];
  }
  return [];
}

/** Placeholders that change at this altitude, keyed by the outcome text. */
export function altitudePlaceholders(altitude: BriefAltitude): Record<string, string> {
  if (altitude !== "prescriptive") return {};
  return {
    "- <an observable criterion; end it with (blocking) when the delivery fails without it>":
      "- <one criterion per item the user asked for, each observable; end it with (blocking) when the delivery fails without it>",
    "<what the deliverable is made of: files and formats; the engine sets the folder>":
      "- <every artifact, one per line: file name and format; the engine sets the folder>",
  };
}

/** The sentence a worker prompt adds about the brief, or "" at outcome. */
export function altitudeWorkerLine(altitude: BriefAltitude): string {
  if (altitude === "guided") {
    return "The brief is guided: follow the structure it suggests (\"Suggested structure\") unless the work calls for a better one, and say in the summary where you departed from it and why.";
  }
  if (altitude === "prescriptive") {
    return "The brief is prescriptive: deliver exactly the artifacts its \"Output\" lists, meet every \"Done when\" criterion item by item, and follow the method it states (\"Method\"); where it states none, the method is yours.";
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
    return "Altitude guided: besides the result, guardrails and definition of done, add a section '## Suggested structure' with the structure you suggest (sections, order, outline).";
  }
  if (altitude === "prescriptive") {
    return "Altitude prescriptive: state one acceptance criterion per item, list every artifact (file name and format) the client receives, and add a section '## Method' with the method the work follows.";
  }
  return "";
}
