import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep, posix, win32 } from "node:path";

export type ExternalAppPlatform = "win32" | "darwin" | "linux";

export interface ExternalCommand {
  command: string;
  args: string[];
  timeout_ms?: number;
}

export type ExternalCommandRecipe = ExternalCommand | Partial<Record<ExternalAppPlatform, ExternalCommand>>;

export interface ExternalAppDependency {
  id: string;
  name: string;
  description: string;
  required: boolean;
  capability: string;
  license: string;
  homepage: string;
  source: string;
  platforms: ExternalAppPlatform[];
  permissions: string[];
  compatibility: { requirement: string; check?: ExternalCommandRecipe };
  presence_check: ExternalCommandRecipe;
  install: Record<string, ExternalCommand>;
  source_squads: string[];
}

export interface SquadDependencySource { slug: string; path: string }

export type ExternalAppStatus =
  | "pending_decision"
  | "declined"
  | "already_present"
  | "installed"
  | "unsupported_platform"
  | "install_failed"
  | "compatibility_failed"
  | "not_attempted";

export interface ExternalAppResult {
  id: string;
  name: string;
  description: string;
  required: boolean;
  capability: string;
  license: string;
  homepage: string;
  source: string;
  platforms: ExternalAppPlatform[];
  platform: ExternalAppPlatform;
  permissions: string[];
  compatibility_requirement: string;
  source_squads: string[];
  presence_check?: ExternalCommand;
  compatibility_check?: ExternalCommand;
  install_action?: ExternalCommand;
  status: ExternalAppStatus;
  enable_hint?: string;
  error?: string;
}

export interface ExternalAppPlan {
  digest: string;
  platform: ExternalAppPlatform;
  results: ExternalAppResult[];
}

export interface ExternalActionResult {
  app_id: string;
  phase: "presence_check" | "compatibility_check" | "install" | "post_install_presence" | "post_install_compatibility";
  status: "succeeded" | "failed";
  error?: string;
}

export interface ExternalAppExecution {
  results: ExternalAppResult[];
  readiness: "ready" | "degraded" | "blocked" | "confirmation_required";
  degradedCapabilities: string[];
  blockingErrors: string[];
  actions: ExternalActionResult[];
  changedApps: string[];
  warnings: string[];
  confirmationRequired: boolean;
}

const PLATFORMS = new Set<ExternalAppPlatform>(["win32", "darwin", "linux"]);
const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const APP_FIELDS = new Set([
  "id", "name", "description", "required", "capability", "license", "homepage", "source",
  "platforms", "permissions", "compatibility", "presence_check", "install",
]);
const COMPATIBILITY_FIELDS = new Set(["requirement", "check"]);
const COMMAND_FIELDS = new Set(["command", "args", "timeout_ms"]);
const SENSITIVE_NAME_PART = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION)/i;
const SENSITIVE_ASSIGNMENT = /(?:^|[^A-Za-z0-9])([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION)[A-Za-z0-9_-]*)\s*[:=]/i;
const COMMON_SECRET = /(?:Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bxox[baprs]-[A-Za-z0-9-]{8,})/i;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;
const SHELL_EXECUTABLES = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "fish",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);
const EXECUTABLE_LAUNCHERS = new Set(["env", "env.exe", "busybox", "busybox.exe", "wsl", "wsl.exe"]);
const INLINE_INTERPRETER_FLAGS: Record<string, Set<string>> = {
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  "bun.exe": new Set(["-e", "--eval", "-p", "--print"]),
  node: new Set(["-e", "--eval", "-p", "--print"]),
  "node.exe": new Set(["-e", "--eval", "-p", "--print"]),
  deno: new Set(["eval"]),
  "deno.exe": new Set(["eval"]),
  python: new Set(["-c"]),
  "python.exe": new Set(["-c"]),
  python3: new Set(["-c"]),
  "python3.exe": new Set(["-c"]),
  ruby: new Set(["-e"]),
  "ruby.exe": new Set(["-e"]),
  perl: new Set(["-e"]),
  "perl.exe": new Set(["-e"]),
};

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(raw: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field '${key}'`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  if (CONTROL_CHARACTER.test(value)) throw new Error(`${label} must not contain control characters or line breaks`);
  return value.trim();
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (value.some((item) => CONTROL_CHARACTER.test(item))) throw new Error(`${label} must not contain control characters or line breaks`);
  return value.map((item) => item.trim());
}

function normalizedArgumentName(value: string): string {
  return value.replace(/^-+/, "").replaceAll("-", "_").toUpperCase();
}

function hasCredentialedUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    return [...url.searchParams.keys()].some((key) => SENSITIVE_NAME_PART.test(normalizedArgumentName(key)));
  } catch { return false; }
}

function validatePublicUrl(value: unknown, label: string): string {
  const text = requireString(value, label);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* malformed encoding is handled by URL; scan the raw text */ }
  if (url.username || url.password
    || [...url.searchParams.keys()].some((key) => SENSITIVE_NAME_PART.test(normalizedArgumentName(key)))
    || COMMON_SECRET.test(decoded) || SENSITIVE_ASSIGNMENT.test(decoded)) {
    throw new Error(`${label} contains a credentialed URL`);
  }
  return text;
}

function rejectSecretArgs(args: string[], label: string): void {
  for (const arg of args) {
    const equals = arg.indexOf("=");
    const isNamedArgument = equals > 0 || arg.startsWith("-") || /^[A-Z][A-Z0-9_-]+$/.test(arg);
    const key = equals > 0 ? arg.slice(0, equals) : arg;
    if ((isNamedArgument && SENSITIVE_NAME_PART.test(normalizedArgumentName(key)))
      || SENSITIVE_ASSIGNMENT.test(arg) || COMMON_SECRET.test(arg) || hasCredentialedUrl(arg)) {
      throw new Error(`${label} contains secret-bearing argv`);
    }
  }
}

function rejectShellOrInlineInterpreter(command: string, args: string[], label: string): void {
  const executable = command.replace(/^.*[\\/]/, "").toLowerCase();
  if (SHELL_EXECUTABLES.has(executable) || EXECUTABLE_LAUNCHERS.has(executable)) {
    throw new Error(`${label} must not invoke a shell or inline interpreter`);
  }
  const forbiddenFlags = INLINE_INTERPRETER_FLAGS[executable]
    ?? (/^python\d+(?:\.\d+)?(?:\.exe)?$/.test(executable) ? new Set(["-c"]) : undefined);
  if (forbiddenFlags && args.some((arg) => {
    const lower = arg.toLowerCase();
    return [...forbiddenFlags].some((flag) => lower === flag
      || (flag.startsWith("--") && lower.startsWith(`${flag}=`))
      || (flag.startsWith("-") && !flag.startsWith("--") && lower.startsWith(flag) && lower.length > flag.length));
  })) {
    throw new Error(`${label} must not invoke a shell or inline interpreter`);
  }
}

function parseCommand(value: unknown, label: string): ExternalCommand {
  const raw = requireObject(value, label);
  rejectUnknownFields(raw, COMMAND_FIELDS, label);
  const command = requireString(raw.command, `${label}.command`);
  const absoluteOnSupportedPlatform = posix.isAbsolute(command) || win32.isAbsolute(command);
  if (!absoluteOnSupportedPlatform && (command.startsWith(".") || command.includes("/") || command.includes("\\") || /\s/.test(command))) {
    throw new Error(`${label}.command must be an executable name or absolute path`);
  }
  const args = raw.args === undefined ? [] : requireStringArray(raw.args, `${label}.args`);
  rejectSecretArgs(args, `${label}.args`);
  rejectShellOrInlineInterpreter(command, args, label);
  let timeoutMs: number | undefined;
  if (raw.timeout_ms !== undefined) {
    if (!Number.isInteger(raw.timeout_ms) || (raw.timeout_ms as number) < 1 || (raw.timeout_ms as number) > 1_800_000) {
      throw new Error(`${label}.timeout_ms must be an integer between 1 and 1800000`);
    }
    timeoutMs = raw.timeout_ms as number;
  }
  return { command, args, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) };
}

function parseCommandRecipe(value: unknown, label: string, platforms: ExternalAppPlatform[]): ExternalCommandRecipe {
  const raw = requireObject(value, label);
  if ("command" in raw || "args" in raw || "timeout_ms" in raw) return parseCommand(raw, label);

  const declared = new Set(platforms);
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new Error(`${label} must be a command or platform command map`);
  for (const platform of keys) {
    if (!PLATFORMS.has(platform as ExternalAppPlatform)) throw new Error(`${label} contains unsupported platform '${platform}'`);
    if (!declared.has(platform as ExternalAppPlatform)) throw new Error(`${label} contains undeclared platform '${platform}'`);
  }
  for (const platform of platforms) {
    if (raw[platform] === undefined) throw new Error(`${label} must define a command for declared platform '${platform}'`);
  }

  return Object.fromEntries(platforms.map((platform) => [
    platform,
    parseCommand(raw[platform], `${label}.${platform}`),
  ])) as Partial<Record<ExternalAppPlatform, ExternalCommand>>;
}

function commandForPlatform(recipe: ExternalCommandRecipe | undefined, platform: ExternalAppPlatform): ExternalCommand | undefined {
  if (!recipe) return undefined;
  return "command" in recipe ? (recipe as ExternalCommand) : recipe[platform];
}

function parseExternalApp(value: unknown, sourceSlug: string, index: number): ExternalAppDependency {
  const label = `external_apps[${index}] in squad '${sourceSlug}'`;
  const raw = requireObject(value, label);
  rejectUnknownFields(raw, APP_FIELDS, label);
  const id = requireString(raw.id, `${label}.id`);
  if (!STABLE_ID.test(id)) throw new Error(`${label}.id must be a stable lowercase id`);
  if (typeof raw.required !== "boolean") throw new Error(`${label}.required must be a boolean`);
  const platforms = (requireStringArray(raw.platforms, `${label}.platforms`) as ExternalAppPlatform[]).sort();
  if (platforms.length === 0 || platforms.some((platform) => !PLATFORMS.has(platform))) {
    throw new Error(`${label}.platforms must contain win32, darwin, or linux`);
  }
  if (new Set(platforms).size !== platforms.length) throw new Error(`${label}.platforms must not contain duplicates`);

  const compatibilityRaw = requireObject(raw.compatibility, `${label}.compatibility`);
  rejectUnknownFields(compatibilityRaw, COMPATIBILITY_FIELDS, `${label}.compatibility`);
  const installRaw = requireObject(raw.install, `${label}.install`);
  for (const platform of Object.keys(installRaw)) {
    if (!PLATFORMS.has(platform as ExternalAppPlatform)) throw new Error(`${label}.install contains unsupported install platform '${platform}'`);
    if (!platforms.includes(platform as ExternalAppPlatform)) throw new Error(`${label}.install contains undeclared platform '${platform}'`);
  }
  const install: Record<string, ExternalCommand> = {};
  for (const platform of platforms) install[platform] = parseCommand(installRaw[platform], `${label}.install.${platform}`);

  return {
    id,
    name: requireString(raw.name, `${label}.name`),
    description: requireString(raw.description, `${label}.description`),
    required: raw.required,
    capability: requireString(raw.capability, `${label}.capability`),
    license: requireString(raw.license, `${label}.license`),
    homepage: validatePublicUrl(raw.homepage, `${label}.homepage`),
    source: validatePublicUrl(raw.source, `${label}.source`),
    platforms,
    permissions: requireStringArray(raw.permissions, `${label}.permissions`).sort(),
    compatibility: {
      requirement: requireString(compatibilityRaw.requirement, `${label}.compatibility.requirement`),
      ...(compatibilityRaw.check === undefined ? {} : {
        check: parseCommandRecipe(compatibilityRaw.check, `${label}.compatibility.check`, platforms),
      }),
    },
    presence_check: parseCommandRecipe(raw.presence_check, `${label}.presence_check`, platforms),
    install,
    source_squads: [sourceSlug],
  };
}

function comparable(app: ExternalAppDependency): string {
  const { source_squads: _sources, ...declaration } = app;
  return JSON.stringify(declaration);
}

export function discoverExternalApps(squads: SquadDependencySource[]): ExternalAppDependency[] {
  const byId = new Map<string, ExternalAppDependency>();
  for (const squad of squads) {
    const sidecar = join(squad.path, "dependencies.yaml");
    if (!existsSync(sidecar)) continue;
    const squadRoot = realpathSync(squad.path);
    const actualSidecar = realpathSync(sidecar);
    const sidecarRelative = relative(squadRoot, actualSidecar);
    if (sidecarRelative === "" || sidecarRelative === ".." || sidecarRelative.startsWith(`..${sep}`) || posix.isAbsolute(sidecarRelative) || win32.isAbsolute(sidecarRelative)) {
      throw new Error(`dependencies.yaml for squad '${squad.slug}' escapes the squad root`);
    }
    let document: unknown;
    try {
      document = (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML.parse(readFileSync(actualSidecar, "utf8"));
    } catch (error) {
      throw new Error(`invalid dependencies.yaml for squad '${squad.slug}': ${(error as Error).message}`);
    }
    if (document === null || document === undefined) continue;
    const root = requireObject(document, `dependencies.yaml for squad '${squad.slug}'`);
    if (root.external_apps === undefined) continue;
    if (!Array.isArray(root.external_apps)) throw new Error(`external_apps in squad '${squad.slug}' must be an array`);
    root.external_apps.forEach((entry, index) => {
      const app = parseExternalApp(entry, squad.slug, index);
      const previous = byId.get(app.id);
      if (!previous) return void byId.set(app.id, app);
      if (comparable(previous) !== comparable(app)) {
        throw new Error(`conflicting external app declaration '${app.id}' in squads '${previous.source_squads.join("', '")}' and '${squad.slug}'`);
      }
      previous.source_squads.push(squad.slug);
      previous.source_squads.sort();
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function digestFor(platform: ExternalAppPlatform, results: ExternalAppResult[]): string {
  const applications = results.map(({ enable_hint: _hint, error: _error, ...declaration }) => declaration);
  const payload = JSON.stringify(canonicalize({ schema_version: "1.0", platform, external_apps: applications }));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function unsupportedHint(platform: ExternalAppPlatform): string {
  return `No installer is declared for ${platform}; use a supported platform or provide a compatible installation.`;
}

export function buildExternalAppPlan(
  dependencies: ExternalAppDependency[],
  options: { platform?: ExternalAppPlatform } = {},
): ExternalAppPlan {
  const platform = options.platform ?? (process.platform as ExternalAppPlatform);
  const results = [...dependencies].sort((a, b) => a.id.localeCompare(b.id)).map((app): ExternalAppResult => {
    const presenceCheck = commandForPlatform(app.presence_check, platform);
    const compatibilityCheck = commandForPlatform(app.compatibility.check, platform);
    const supported = app.platforms.includes(platform) && !!app.install[platform] && !!presenceCheck;
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      required: app.required,
      capability: app.capability,
      license: app.license,
      homepage: app.homepage,
      source: app.source,
      platforms: app.platforms,
      platform,
      permissions: app.permissions,
      compatibility_requirement: app.compatibility.requirement,
      source_squads: [...app.source_squads].sort(),
      ...(presenceCheck ? { presence_check: presenceCheck } : {}),
      ...(compatibilityCheck ? { compatibility_check: compatibilityCheck } : {}),
      ...(app.install[platform] ? { install_action: app.install[platform] } : {}),
      status: supported ? "pending_decision" : "unsupported_platform",
      ...(!supported ? { enable_hint: unsupportedHint(platform) } : {}),
    };
  });
  return { digest: digestFor(platform, results), platform, results };
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runCommand(command: ExternalCommand): { ok: boolean; error?: string } {
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    env: minimalEnvironment(),
    shell: false,
    timeout: command.timeout_ms ?? 120_000,
    windowsHide: true,
  });
  if (result.status === 0) return { ok: true };
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return { ok: false, error: "command timed out" };
  if (result.error) return { ok: false, error: "executable not found or could not start" };
  return { ok: false, error: `command exited with code ${result.status ?? "unknown"}` };
}

function cloneResults(results: ExternalAppResult[]): ExternalAppResult[] {
  return results.map((result) => ({
    ...result,
    platforms: [...result.platforms],
    permissions: [...result.permissions],
    source_squads: [...result.source_squads],
    ...(result.presence_check ? { presence_check: { ...result.presence_check, args: [...result.presence_check.args] } } : {}),
    ...(result.compatibility_check ? { compatibility_check: { ...result.compatibility_check, args: [...result.compatibility_check.args] } } : {}),
    ...(result.install_action ? { install_action: { ...result.install_action, args: [...result.install_action.args] } } : {}),
  }));
}

function summarize(
  results: ExternalAppResult[],
  actions: ExternalActionResult[] = [],
  changedApps: string[] = [],
  warnings: string[] = [],
): ExternalAppExecution {
  const available = new Set<ExternalAppStatus>(["already_present", "installed"]);
  const unavailable = results.filter((result) => !available.has(result.status));
  const required = unavailable.filter((result) => result.required);
  const degradedCapabilities = [...new Set(unavailable.filter((result) => !result.required).map((result) => result.capability))];
  const blockingErrors = required.map((result) => `required external app unavailable: ${result.id} (${result.status})`);
  return {
    results,
    readiness: required.length > 0 ? "blocked" : degradedCapabilities.length > 0 ? "degraded" : "ready",
    degradedCapabilities,
    blockingErrors,
    actions,
    changedApps,
    warnings,
    confirmationRequired: false,
  };
}

export function confirmationRequiredExternalAppPlan(plan: ExternalAppPlan, error?: string): ExternalAppExecution {
  return {
    results: cloneResults(plan.results),
    readiness: "confirmation_required",
    degradedCapabilities: [],
    blockingErrors: error ? [error] : [],
    actions: [],
    changedApps: [],
    warnings: [],
    confirmationRequired: true,
  };
}

export function declineExternalAppPlan(plan: ExternalAppPlan): ExternalAppExecution {
  const results = cloneResults(plan.results).map((result) => result.status === "unsupported_platform" ? result : {
    ...result,
    status: "declined" as const,
    enable_hint: `Re-run pack install with --force --dry-run to preflight and accept its exact digest using --force --accept-external-apps=<digest>, enabling '${result.capability}'.`,
  });
  return summarize(results);
}

export function deferOptionalExternalAppPlan(plan: ExternalAppPlan): ExternalAppExecution {
  if (plan.results.some((result) => result.required)) return confirmationRequiredExternalAppPlan(plan);
  const results = cloneResults(plan.results).map((result) => result.status === "pending_decision" ? {
    ...result,
    enable_hint: `Re-run pack install with --force --dry-run to preflight and accept its exact digest using --force --accept-external-apps=<digest>, enabling '${result.capability}'.`,
  } : result);
  return summarize(results);
}

function recordAction(actions: ExternalActionResult[], appId: string, phase: ExternalActionResult["phase"], command: ExternalCommand): boolean {
  const outcome = runCommand(command);
  actions.push({ app_id: appId, phase, status: outcome.ok ? "succeeded" : "failed", ...(outcome.error ? { error: outcome.error } : {}) });
  return outcome.ok;
}

export function executeExternalAppPlan(plan: ExternalAppPlan, acceptedDigest: string): ExternalAppExecution {
  const currentDigest = digestFor(plan.platform, plan.results);
  if (acceptedDigest !== plan.digest || currentDigest !== plan.digest) {
    return confirmationRequiredExternalAppPlan(plan, "external app consent digest mismatch; generate a new preflight plan");
  }
  const results = cloneResults(plan.results);
  const actions: ExternalActionResult[] = [];
  const changedApps: string[] = [];
  const warnings: string[] = [];

  for (const result of results) {
    if (result.status === "unsupported_platform") continue;
    if (!result.presence_check) {
      result.status = "unsupported_platform";
      result.enable_hint = unsupportedHint(result.platform);
      continue;
    }
    const present = recordAction(actions, result.id, "presence_check", result.presence_check);
    const compatible = present && (!result.compatibility_check || recordAction(actions, result.id, "compatibility_check", result.compatibility_check));
    if (present && compatible) result.status = "already_present";
  }

  if (results.some((result) => result.required && result.status === "unsupported_platform")) {
    for (const result of results) {
      if (result.status === "pending_decision") {
        result.status = "not_attempted";
        result.enable_hint = "Resolve the required platform blocker, then generate and accept a new preflight plan.";
      }
    }
    return summarize(results, actions, changedApps, warnings);
  }

  const installOne = (result: ExternalAppResult): void => {
    if (!result.install_action) {
      result.status = "unsupported_platform";
      result.enable_hint = unsupportedHint(result.platform);
      return;
    }
    if (!result.presence_check) {
      result.status = "unsupported_platform";
      result.enable_hint = unsupportedHint(result.platform);
      return;
    }
    if (!recordAction(actions, result.id, "install", result.install_action)) {
      result.status = "install_failed";
      result.error = actions.at(-1)?.error ?? "external installer failed";
      result.enable_hint = "Resolve the installer error, then rerun this accepted plan; generate a new preflight if the manifest changes.";
      return;
    }
    changedApps.push(result.id);
    if (!recordAction(actions, result.id, "post_install_presence", result.presence_check)) {
      result.status = "install_failed";
      result.error = "application was not present after installation";
      result.enable_hint = "Verify the application is on PATH, then generate a new preflight plan.";
      return;
    }
    if (result.compatibility_check && !recordAction(actions, result.id, "post_install_compatibility", result.compatibility_check)) {
      result.status = "compatibility_failed";
      result.error = "compatibility check failed after installation";
      result.enable_hint = `Install a version matching '${result.compatibility_requirement}', then generate a new preflight plan.`;
      return;
    }
    result.status = "installed";
    delete result.error;
    delete result.enable_hint;
  };

  for (const result of results.filter((entry) => entry.required && entry.status === "pending_decision")) installOne(result);
  const requiredBlocked = results.some((result) => result.required && result.status !== "already_present" && result.status !== "installed");
  if (requiredBlocked) {
    for (const result of results.filter((entry) => !entry.required && entry.status === "pending_decision")) {
      result.status = "not_attempted";
      result.enable_hint = "Resolve required external app failures before retrying this optional installation.";
    }
  } else {
    for (const result of results.filter((entry) => !entry.required && entry.status === "pending_decision")) installOne(result);
  }
  const changedAppFailedVerification = results.some((result) => changedApps.includes(result.id)
    && (result.status === "install_failed" || result.status === "compatibility_failed"));
  if (actions.some((action) => action.phase === "install" && action.status === "failed") || changedAppFailedVerification) {
    warnings.push("External installers may have left partial changes; external changes were not rolled back.");
  }
  return summarize(results, actions, changedApps, warnings);
}
