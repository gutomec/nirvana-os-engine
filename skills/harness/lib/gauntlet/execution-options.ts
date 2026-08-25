import { resolveExecutionMode } from "./compiler.ts";
import type { ExecutionMode, GauntletIntensity } from "./types.ts";

const MODES = new Set<ExecutionMode>(["standard", "gauntlet", "auto"]);
const INTENSITIES = new Set<GauntletIntensity>(["light", "balanced", "exhaustive"]);

function value(argv: string[], name: string): string | undefined {
  const index = argv.findIndex(argument => argument === name || argument.startsWith(`${name}=`));
  if (index < 0) return undefined;
  return argv[index].includes("=") ? argv[index].slice(argv[index].indexOf("=") + 1) : argv[index + 1];
}

export function parseExecutionOptions(argv: string[], environment: Record<string, string | undefined> = process.env): {
  requestedMode: ExecutionMode;
  resolvedMode: "standard" | "gauntlet";
  intensity: GauntletIntensity;
  reason: string;
} {
  const rawMode = value(argv, "--execution-mode") ?? environment.NIRVANA_EXECUTION_MODE ?? "standard";
  const rawIntensity = value(argv, "--gauntlet-intensity") ?? environment.NIRVANA_GAUNTLET_INTENSITY ?? "balanced";
  if (!MODES.has(rawMode as ExecutionMode)) throw new Error(`invalid execution mode '${rawMode}'`);
  if (!INTENSITIES.has(rawIntensity as GauntletIntensity)) throw new Error(`invalid gauntlet intensity '${rawIntensity}'`);
  const requestedMode = rawMode as ExecutionMode;
  const resolved = resolveExecutionMode({ mode: requestedMode, intensity: rawIntensity as GauntletIntensity,
    allowAutoGauntlet: environment.NIRVANA_ALLOW_AUTO_GAUNTLET === "1" }, {
    verifiable: environment.NIRVANA_BRIEF_VERIFIABLE === "1",
    risk: environment.NIRVANA_BRIEF_RISK === "high" ? "high" : environment.NIRVANA_BRIEF_RISK === "medium" ? "medium" : "low",
  });
  return { requestedMode, resolvedMode: resolved.mode, intensity: rawIntensity as GauntletIntensity, reason: resolved.reason };
}
