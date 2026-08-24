import { digestJcs } from "./state.ts";
import type { ServiceConfigV1 } from "./types.ts";

export interface ServiceHealthV1 { schema_version: "1.0.0"; mode: "service"; instance_id: string; port: number; scope: "global" | "project"; project_root_digest?: `sha256:${string}`; lifetime: "persistent"; allow_actions: false; engine_version: string; uptime_seconds: number; effective_config_digest: `sha256:${string}`; process_digest: `sha256:${string}`; extension_root_digest: `sha256:${string}`; read_only: true; persistent: true }

export function buildServiceHealth(config: ServiceConfigV1, instance: { instance_id: string; process_digest: string }, metadata: { engineVersion: string; extensionRootDigest: `sha256:${string}` }): Omit<ServiceHealthV1, "uptime_seconds"> {
  return {
    schema_version: "1.0.0",
    mode: "service",
    instance_id: instance.instance_id,
    port: config.port,
    scope: config.scope,
    ...(config.scope === "project" ? { project_root_digest: config.project_root_digest } : {}),
    lifetime: "persistent",
    allow_actions: false,
    engine_version: metadata.engineVersion,
    effective_config_digest: digestJcs(config),
    process_digest: instance.process_digest as `sha256:${string}`,
    extension_root_digest: metadata.extensionRootDigest,
    read_only: true,
    persistent: true,
  };
}
