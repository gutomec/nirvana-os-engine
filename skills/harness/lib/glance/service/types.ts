export type Sha256 = `sha256:${string}`;

export interface GlanceServiceCommandResultV1 { schema_version: "1.0.0"; command: "start" | "stop" | "status" | "restart"; ok: boolean; state: "starting" | "running" | "stopping" | "stopped" | "stale" | "conflict" | "error"; instance_id?: string; pid?: number; url?: string; port?: number; scope?: "global" | "project"; project_root?: string; started_at?: string; uptime_seconds?: number; engine_version?: string; read_only: true; persistent: true; log_path: string; extension_root_digest?: Sha256; requested_config_digest?: Sha256; effective_config_digest?: Sha256; rollback_attempted?: boolean; rollback_state?: "not_needed" | "restored_previous" | "restore_failed"; restart_required?: boolean; code: string; message: string; }
export interface ServiceTarget { nirvanaHomeDigest: Sha256; scope: "global" | "project"; projectRootDigest?: Sha256; port: number; configDigest: Sha256; }

export type ServiceConfigV1 =
  | { schema_version: "1.0.0"; scope: "global"; host: "127.0.0.1"; port: number; read_only: true; lifetime: "persistent"; no_open: true }
  | { schema_version: "1.0.0"; scope: "project"; project_root: string; project_root_digest: Sha256; host: "127.0.0.1"; port: number; read_only: true; lifetime: "persistent"; no_open: true };

export interface ServiceInstanceV1 { schema_version: "1.0.0"; instance_id: string; pid: number; state: "starting" | "running" | "stopping" | "error"; started_at: string; config_digest: Sha256; process_digest: Sha256; control_secret_ref: string; control_secret_digest: Sha256; log_ref: string; last_restart?: { attempted_at: string; requested_config_digest: Sha256; effective_config_digest: Sha256; rollback_state: "not_needed" | "restored_previous" | "restore_failed" }; }
export interface ServiceLockOwnerV1 { schema_version: "1.0.0"; owner_id: string; manager_pid: number; operation: "start" | "stop" | "restart"; target: { nirvana_home_digest: Sha256; scope: "global" | "project"; project_root_digest?: Sha256; port: number }; acquired_at: string; expires_at: string; token_ref: string; token_digest: Sha256; }
export interface ServiceStopRequestV1 { schema_version: "1.0.0"; request_id: string; instance_id: string; action: "stop"; created_at: string; expires_at: string; nonce_ref: string; nonce_digest: Sha256; auth_algorithm: "hmac-sha256"; auth_tag: string; }
