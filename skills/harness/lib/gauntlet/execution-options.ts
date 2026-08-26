import { resolveSetting } from "../../../_shared/lib/settings.ts";
import { resolveExecutionMode } from "./compiler.ts";
import type { ExecutionMode, GauntletIntensity } from "./types.ts";

const MODES = new Set<ExecutionMode>(["standard", "gauntlet", "auto"]);
const INTENSITIES = new Set<GauntletIntensity>(["light", "balanced", "exhaustive"]);

function value(argv: string[], name: string): string | undefined {
  const index = argv.findIndex(argument => argument === name || argument.startsWith(`${name}=`));
  if (index < 0) return undefined;
  return argv[index].includes("=") ? argv[index].slice(argv[index].indexOf("=") + 1) : argv[index + 1];
}

/**
 * The execution mode and intensity of one dispatch: the flags first, then the
 * `gauntlet.default_mode`, `gauntlet.default_intensity` and
 * `gauntlet.auto_allowed` settings resolved over `environment` (the variables
 * NIRVANA_EXECUTION_MODE, NIRVANA_GAUNTLET_INTENSITY and
 * NIRVANA_ALLOW_AUTO_GAUNTLET, else the project or global config). The brief
 * hints NIRVANA_BRIEF_VERIFIABLE and NIRVANA_BRIEF_RISK describe one run,
 * not a preference, so they stay variables.
 */
export function parseExecutionOptions(argv: string[], environment: Record<string, string | undefined> = process.env): {
  requestedMode: ExecutionMode;
  resolvedMode: "standard" | "gauntlet";
  intensity: GauntletIntensity;
  reason: string;
} {
  const settings = { env: environment };
  const rawMode = value(argv, "--execution-mode") ?? resolveSetting("gauntlet.default_mode", settings).value;
  const rawIntensity = value(argv, "--gauntlet-intensity") ?? resolveSetting("gauntlet.default_intensity", settings).value;
  if (!MODES.has(rawMode as ExecutionMode)) throw new Error(`invalid execution mode '${rawMode}'`);
  if (!INTENSITIES.has(rawIntensity as GauntletIntensity)) throw new Error(`invalid gauntlet intensity '${rawIntensity}'`);
  const requestedMode = rawMode as ExecutionMode;
  const resolved = resolveExecutionMode({ mode: requestedMode, intensity: rawIntensity as GauntletIntensity,
    allowAutoGauntlet: resolveSetting("gauntlet.auto_allowed", settings).value }, {
    verifiable: environment.NIRVANA_BRIEF_VERIFIABLE === "1",
    risk: environment.NIRVANA_BRIEF_RISK === "high" ? "high" : environment.NIRVANA_BRIEF_RISK === "medium" ? "medium" : "low",
  });
  return { requestedMode, resolvedMode: resolved.mode, intensity: rawIntensity as GauntletIntensity, reason: resolved.reason };
}
