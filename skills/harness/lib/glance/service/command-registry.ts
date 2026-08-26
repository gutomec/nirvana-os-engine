export type ServiceVerb = "start" | "stop" | "status" | "restart";
export interface ServiceOptions { port?: number; scope?: "global" | "project"; projectRoot?: string; json?: boolean }
export type ServiceParse = { kind: "help"; level: "service" | "verb"; command?: ServiceVerb; exitCode: 0 | 2 } | { kind: "service"; command: ServiceVerb; options: ServiceOptions };

export class ServiceUsageError extends Error {
  constructor(readonly code: string) { super(`SERVICE_USAGE:${code}`); }
}

const SERVICE_VERBS = new Set<ServiceVerb>(["start", "stop", "status", "restart"]);
const ALL_VERBS: readonly ServiceVerb[] = ["start", "stop", "status", "restart"];

function parsePortValue(raw: unknown): number {
  const port = typeof raw === "string" ? Number(raw) : raw;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new ServiceUsageError("INVALID_PORT");
  return port;
}

function parseScopeValue(raw: unknown): "global" | "project" {
  if (raw !== "global" && raw !== "project") throw new ServiceUsageError("INVALID_SCOPE");
  return raw;
}

function parseProjectRootValue(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ServiceUsageError("INVALID_PROJECT_ROOT");
  return raw;
}

interface OptionDescriptor { flag: string; valueHint?: string; description: string; verbs: readonly ServiceVerb[]; parse?(raw: string): unknown }

export const OPTION_REGISTRY: readonly OptionDescriptor[] = [
  { flag: "port", valueHint: "<n>", description: "fixed local port, integer 1024-65535 (default 3737)", verbs: ["start", "restart"], parse: parsePortValue },
  { flag: "scope", valueHint: "<global|project>", description: "global or project scope (default global)", verbs: ["start", "restart"], parse: parseScopeValue },
  { flag: "project-root", valueHint: "<path>", description: "project root used when scope is project", verbs: ["start", "restart"], parse: parseProjectRootValue },
  { flag: "json", description: "machine-readable JSON result", verbs: ALL_VERBS },
];

function optionsAllowedFor(verb: ServiceVerb): readonly OptionDescriptor[] {
  return OPTION_REGISTRY.filter(option => option.verbs.includes(verb));
}

export function parseOptionsFromRegistry(command: ServiceVerb, flags: Readonly<Record<string, unknown>>): ServiceOptions {
  const allowed = optionsAllowedFor(command);
  const options: ServiceOptions = {};
  for (const [flagName, raw] of Object.entries(flags)) {
    if (raw === undefined || raw === false) continue;
    const descriptor = allowed.find(candidate => candidate.flag === flagName);
    if (!descriptor) throw new ServiceUsageError(`ILLEGAL_OPTION:${flagName}`);
    if (descriptor.parse) {
      if (raw === true) throw new ServiceUsageError(`${flagName.toUpperCase()}_REQUIRES_VALUE`);
      (options as Record<string, unknown>)[descriptor.flag === "project-root" ? "projectRoot" : descriptor.flag] = descriptor.parse(raw);
    } else {
      (options as Record<string, unknown>)[descriptor.flag] = true;
    }
  }
  return options;
}

export const SERVICE_EXIT_TABLE = Object.freeze({ ok: 0, stoppedStatus: 1, usage: 2, unsupported: 2, stale: 3, conflict: 4, timeout: 5, io: 6 } as const);

export function serviceExitCode(result: { ok: boolean; state: string; code?: string }): number {
  if (/SERVICE_UNSUPPORTED/.test(result.code ?? "")) return SERVICE_EXIT_TABLE.unsupported;
  if (result.ok) return SERVICE_EXIT_TABLE.ok;
  if (result.state === "conflict") return SERVICE_EXIT_TABLE.conflict;
  if (/TIMEOUT/.test(result.code ?? "")) return SERVICE_EXIT_TABLE.timeout;
  if (result.state === "stale") return SERVICE_EXIT_TABLE.stale;
  if (result.state === "stopped") return SERVICE_EXIT_TABLE.stoppedStatus;
  return SERVICE_EXIT_TABLE.io;
}

export function parseServiceCommand(positional: readonly string[], flags: Readonly<Record<string, unknown>>): ServiceParse {
  const raw = positional[0];
  const explicitHelp = flags.help === true || flags.h === true;
  if (!raw) return { kind: "help", level: "service", exitCode: explicitHelp ? 0 : 2 };
  if (!SERVICE_VERBS.has(raw as ServiceVerb) || positional.length > 1) return { kind: "help", level: "service", exitCode: 2 };
  const command = raw as ServiceVerb;
  if (explicitHelp) return { kind: "help", level: "verb", command, exitCode: 0 };
  return { kind: "service", command, options: parseOptionsFromRegistry(command, flags) };
}

const VERB_DESCRIPTIONS: Record<ServiceVerb, string> = {
  start: "starts the detached worker and waits for health",
  stop: "requests authenticated graceful drain and waits for confirmation",
  status: "verifies state, process, listener and health identity",
  restart: "stops the verified instance and starts again with the previous config unless overridden",
};

export function renderGlanceHelp(level: "top" | "service" | "verb", command?: ServiceVerb): string {
  if (level === "top") {
    return [
      "glance — Nirvana cockpit (web UI)",
      "",
      "USAGE",
      "  nrv glance [options]",
      "  nrv glance service <start|stop|status|restart> [options]",
      "",
      "Normal mode:",
      "  Opens the local Glance UI and stops after 30 minutes of inactivity by default.",
      "  Existing --port, --no-open, --idle-min and --read-only behavior is preserved.",
      "",
      "Service mode:",
      "  Runs Glance in the background until explicit stop, process termination,",
      "  or machine shutdown. It never opens a browser, has no idle shutdown,",
      "  binds to 127.0.0.1, and is read-only in v1.",
      "",
      "Service options:",
      "  --port <number>       Fixed local port. Default: 3737.",
      "  --scope <scope>       global or project. Default: current resolved scope.",
      "  --project-root <path> Required for project scope when no current project resolves.",
      "  --json                Machine-readable result for service commands.",
      "",
      "Logs and state:",
      "  Stored under <NIRVANA_HOME>/.nirvana/glance/service/.",
      "",
      "Autostart:",
      "  Never enabled by service start.",
      "",
      'Run "nrv glance service --help" for lifecycle details.',
    ].join("\n");
  }
  const serviceNotes = [
    "EXITS",
    "  0 success or healthy instance · 1 status when stopped · 2 usage/config/unsupported",
    "  3 stale or inconsistent state · 4 conflict · 5 timeout · 6 permission/I/O",
    "",
    "State and logs live under <NIRVANA_HOME>/.nirvana/glance/service/.",
    "The service binds to 127.0.0.1 only, is read-only and persistent, never opens a",
    "browser, has no idle shutdown, and never installs autostart.",
  ];
  const family = [
    "glance service — persistent read-only Glance service",
    "",
    "USAGE",
    "  glance service start [--port <n>] [--scope global|project] [--project-root <p>] [--json]",
    "  glance service status [--json]",
    "  glance service stop [--json]",
    "  glance service restart [--port <n>] [--scope global|project] [--project-root <p>] [--json]",
    "",
    "VERBS",
    ...ALL_VERBS.map(verb => `  ${verb.padEnd(8)} ${VERB_DESCRIPTIONS[verb]}`),
    "",
    ...serviceNotes,
    "",
    "EXAMPLES",
    "  glance service start --scope global --port 3737",
    "  glance service start --scope project --project-root <path>",
  ].join("\n");
  if (level === "verb" && command) {
    const optionLines = optionsAllowedFor(command).map(option => `  --${option.flag}${option.valueHint ? ` ${option.valueHint}` : ""}   ${option.description}`);
    return [`glance service ${command}`, "", VERB_DESCRIPTIONS[command], "", "OPTIONS", ...optionLines, "", ...serviceNotes].join("\n");
  }
  return family;
}
