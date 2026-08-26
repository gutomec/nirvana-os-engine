#!/usr/bin/env bun
/**
 * glance.ts — Nirvana Glance CLI.
 *
 *   bun glance.ts                          # auto-port, opens browser, Apple theme
 *   bun glance.ts --port 4242              # fixed port
 *   bun glance.ts --no-open                # don't auto-open browser
 *   bun glance.ts --idle-min 60            # idle timeout in minutes (default 30)
 *   bun glance.ts --theme awwwards         # awwwards-style hero
 *   bun glance.ts --allow-actions          # enables write endpoints (Phase 5)
 *   bun glance.ts service start|stop|status|restart
 */

import { parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { join } from "node:path";
import { startServer, type ServerRuntime } from "../lib/glance/server.ts";
import { parseServiceCommand, renderGlanceHelp, serviceExitCode, ServiceUsageError, type ServiceVerb } from "../lib/glance/service/command-registry.ts";
import { createGlanceServiceManager, restartBackend, startBackend, statusBackend, stopBackend } from "../lib/glance/service/manager.ts";
import { resolveServiceRef } from "../lib/glance/service/paths.ts";
import { IncompatibleStateError, readStateFileStrict, type ServiceIo } from "../lib/glance/service/state.ts";
import { validateServiceConfig } from "../lib/glance/service/schema-validator.ts";
import { digestCanonicalPath } from "../lib/glance/service/paths.ts";
import type { ServiceConfigV1 } from "../lib/glance/service/types.ts";

export { renderGlanceHelp };

export interface GlanceRuntimeDependencies { serviceManager: { run(command: string, options: unknown): Promise<number> }; normalRuntime?: Partial<ServerRuntime> }
export type ParsedGlance = { kind: "help"; level: "top" | "service" | "verb"; command?: ServiceVerb; exitCode: 0 | 2 } | { kind: "service"; command: ServiceVerb; options: unknown } | { kind: "normal"; port: number | "auto"; open: boolean; idleMin: number; allowActions: boolean; theme: "apple" | "apple-dark" | "awwwards" };

export function parseGlanceArgs(argv: readonly string[]): ParsedGlance {
  const { positional, flags } = parseArgs([...argv]);
  if (positional[0] === "service") return parseServiceCommand(positional.slice(1), flags);
  if (flags.help || flags.h) return { kind: "help", level: "top", exitCode: 0 };
  const themeFlag = typeof flags.theme === "string" ? flags.theme : "apple";
  const theme = (themeFlag === "apple" || themeFlag === "apple-dark" || themeFlag === "awwwards") ? themeFlag : "apple";
  return {
    kind: "normal",
    port: typeof flags.port === "string" ? Number(flags.port) : "auto",
    open: !flags["no-open"],
    idleMin: typeof flags["idle-min"] === "string" ? Number(flags["idle-min"]) : 30,
    allowActions: !flags["read-only"],
    theme,
  };
}

export async function startNormalGlance(parsed: Extract<ParsedGlance, { kind: "normal" }>, runtime?: Partial<ServerRuntime>): Promise<number> {
  await startServer({ port: parsed.port, open: parsed.open, allowActions: parsed.allowActions, theme: parsed.theme, idleMin: parsed.idleMin }, runtime);
  return 0;
}

export async function runGlance(argv: readonly string[], dependencies: GlanceRuntimeDependencies): Promise<number> {
  let parsed: ParsedGlance;
  try {
    parsed = parseGlanceArgs(argv);
  } catch (error) {
    if (error instanceof ServiceUsageError) {
      console.log(renderGlanceHelp("service"));
      return 2;
    }
    throw error;
  }
  if (parsed.kind === "help") {
    console.log(renderGlanceHelp(parsed.level, parsed.command));
    return parsed.exitCode;
  }
  if (parsed.kind === "service") return dependencies.serviceManager.run(parsed.command, parsed.options);
  return startNormalGlance(parsed, dependencies.normalRuntime);
}

function resolveServiceHome(): string {
  return process.env.NIRVANA_HOME && process.env.NIRVANA_HOME.trim() ? process.env.NIRVANA_HOME : require("node:os").homedir();
}

const strictIo: ServiceIo = { read: (path: string) => require("node:fs").readFileSync(path), archive(path: string) { require("node:fs").rmSync(path); } };

function findCurrentProjectRoot(): string | undefined {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  let current = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, ".env")) || fs.existsSync(path.join(current, ".nirvana"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function globalConfig(port: number): ServiceConfigV1 {
  return { schema_version: "1.0.0", scope: "global", host: "127.0.0.1", port, read_only: true, lifetime: "persistent", no_open: true };
}

export async function resolveServiceRequest(home: string, command: "start" | "restart", options: { port?: number; scope?: string; projectRoot?: string }): Promise<ServiceConfigV1 | undefined> {
  const hasOverrides = options.port !== undefined || options.scope !== undefined || options.projectRoot !== undefined;
  if (command === "restart" && !hasOverrides) return undefined;
  let current: ServiceConfigV1 | undefined;
  try {
    current = readStateFileStrict(resolveServiceRef(join(home, ".nirvana", "glance", "service"), "config.json", true), validateServiceConfig, strictIo);
  } catch (error) {
    if (error instanceof IncompatibleStateError) throw new ServiceUsageError("CURRENT_CONFIG_INVALID");
    current = undefined;
  }
  const scope = (options.scope ?? (current?.scope as string | undefined) ?? "global") === "project" ? "project" : "global";
  const port = options.port ?? current?.port ?? 3737;
  if (scope === "project") {
    const projectRoot = options.projectRoot ?? (current?.scope === "project" ? current.project_root : findCurrentProjectRoot());
    if (!projectRoot) throw new ServiceUsageError("PROJECT_ROOT_REQUIRED");
    const resolvedRoot = require("node:path").resolve(projectRoot);
    return { schema_version: "1.0.0", scope: "project", host: "127.0.0.1", port, read_only: true, lifetime: "persistent", no_open: true, project_root: resolvedRoot, project_root_digest: digestCanonicalPath(resolvedRoot) };
  }
  return globalConfig(port);
}

export function createProductionDependencies(): GlanceRuntimeDependencies {
  const backend = createGlanceServiceManager(resolveServiceHome());
  return {
    serviceManager: {
      async run(command: string, rawOptions: unknown): Promise<number> {
        const options = (rawOptions ?? {}) as { port?: number; scope?: string; projectRoot?: string; json?: boolean };
        try {
          const home = resolveServiceHome();
          let result;
          if (command === "stop") result = await stopBackend(backend, home);
          else if (command === "status") result = await statusBackend(backend, home);
          else {
            const request = await resolveServiceRequest(home, command === "restart" ? "restart" : "start", options);
            result = command === "restart" ? await restartBackend(backend, home, request) : await startBackend(backend, home, request!);
          }
          if (options.json) console.log(JSON.stringify(result));
          else console.log(`glance service ${command}: state=${result.state} code=${result.code}${result.url ? ` url=${result.url}` : ""}`);
          return serviceExitCode(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/SERVICE_UNSUPPORTED/.test(message)) return 2;
          if (/SERVICE_USAGE/.test(message)) return 2;
          if (/TIMEOUT|_HEALTH|WORKER_EXITED/.test(message)) return 5;
          console.error(message);
          return 6;
        }
      },
    },
  };
}

if (import.meta.main) process.exitCode = await runGlance(process.argv.slice(2), createProductionDependencies());
