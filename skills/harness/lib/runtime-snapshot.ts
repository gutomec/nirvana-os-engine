// runtime-snapshot.ts — freezes the runtime, provider and model decision of one
// Run from the universal broker (RuntimeProviderCatalog → RuntimeBroker →
// ModelBroker in skills/_shared/lib).
//
// The three Gauntlet canaries and the multi-target engine used to journal a
// literal `resolved: false` snapshot: the broker was never consulted in
// production. This module asks it once per Run and returns an honest,
// deterministic snapshot that the cutover digests into `policySnapshotRef` and
// journals as `runtime.selection_snapshot`. The journal is append-only, so a
// later catalog update never rewrites what a Run resolved (program criterion 6,
// TR-007 and TR-010).
//
// Catalog sources, in order; a missing directory is skipped without error:
//   runtime.provider_catalog_dir       setting (env NIRVANA_PROVIDER_CATALOG_DIR, else the
//                                      project or global config): a path-delimited list
//                                      that replaces the defaults
//   ~/.nirvana/providers               user catalog
//   <projectRoot>/.nirvana/providers   project catalog
//
// Outcomes:
//   no descriptor for the runtime  → the previous literal plus `reason`; nothing changes
//   stale catalog, not allowed     → unresolved, `catalog.stale: true`, `warnings` (TR-011)
//   stale catalog, allowed         → resolved, with the broker's warning
//   broker incompatible            → `errors` and `rejected`; the caller ends the Run (RT-002)
//   compatible                     → runtime, provider, model, evidence and catalog frozen
//
// No network and no LLM: the catalog is files on disk.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { canonicalJson } from "./run-kernel/canonical-json.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

const requireCjs = createRequire(import.meta.url);
const { RuntimeProviderCatalog } = requireCjs("../../_shared/lib/runtime-provider-catalog.js");
const { ModelBroker } = requireCjs("../../_shared/lib/model-broker.js");
const { RuntimeBroker } = requireCjs("../../_shared/lib/runtime-broker.js");

export const CATALOG_DIR_ENV = "NIRVANA_PROVIDER_CATALOG_DIR";
export const ALLOW_STALE_ENV = "NIRVANA_ALLOW_STALE_CATALOG";
export const NO_DESCRIPTOR_REASON = "no provider descriptor for runtime";

export interface ExecutionSnapshotRequirements {
  featuresRequired?: unknown[];
  modelRequirements?: Record<string, unknown>;
}

export interface FreezeExecutionSnapshotInput {
  runtimeId: string;
  /** Where the runtime decision came from (`flag`, `brief`, `rule`, `default`, `plan`). */
  runtimeSource: string;
  /** Explicit catalog directories; replaces the environment and default resolution. */
  catalogDirs?: string[];
  /** Root whose `.nirvana/providers` is a default source; NIRVANA_PROJECT_ROOT or the cwd otherwise. */
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  requirements?: ExecutionSnapshotRequirements;
  /** Accept a stale catalog; the runtime.allow_stale_catalog setting (env NIRVANA_ALLOW_STALE_CATALOG) otherwise. */
  allowStale?: boolean;
}

/** Deterministic (keys sorted, no `undefined`) so its digest is the Run's `policySnapshotRef`. */
export type ExecutionSnapshot = {
  runtime: { id: string; source: string; resolved?: boolean; version?: string };
  provider: { id?: string; selection?: string; resolved: boolean };
  model: { id?: string; selection?: string; resolved: boolean };
  evidence?: { providerId: string; observedAt: string | null; modelIds: string[] };
  catalog?: { dirs: string[]; observedAt: string | null; stale: boolean };
  policy?: { allowStale: boolean; featuresRequired: unknown[]; modelRequirements: Record<string, unknown> };
  rejected?: Array<{ model: string; reasons: string[] }>;
  degradations?: unknown[];
  warnings?: string[];
  errors?: string[];
  reason?: string;
};

const UNRESOLVED_PROVIDER = { selection: "runtime-provider", resolved: false } as const;
const UNRESOLVED_MODEL = { selection: "runtime-default", resolved: false } as const;

/** Catalog directories that exist, in resolution order. */
export function resolveCatalogDirs(input: { env?: NodeJS.ProcessEnv; projectRoot?: string; homeDir?: string } = {}): string[] {
  const env = input.env ?? process.env;
  const configured = resolveSetting("runtime.provider_catalog_dir", { env, projectRoot: input.projectRoot }).value
    .split(path.delimiter).map(dir => dir.trim()).filter(Boolean);
  const candidates = configured.length ? configured : [
    path.join(input.homeDir ?? os.homedir(), ".nirvana", "providers"),
    path.join(path.resolve(input.projectRoot || env.NIRVANA_PROJECT_ROOT || process.cwd()), ".nirvana", "providers"),
  ];
  return [...new Set(candidates.map(dir => path.resolve(dir)))].filter(dir => fs.existsSync(dir));
}

function nonEmpty<T>(key: string, values: T[] | undefined): Record<string, T[]> {
  return values?.length ? { [key]: values } : {};
}

function freeze(snapshot: ExecutionSnapshot): ExecutionSnapshot {
  return JSON.parse(canonicalJson(snapshot)) as ExecutionSnapshot;
}

export function freezeExecutionSnapshot(input: FreezeExecutionSnapshotInput): ExecutionSnapshot {
  const env = input.env ?? process.env;
  const dirs = input.catalogDirs
    ? [...new Set(input.catalogDirs.map(dir => path.resolve(dir)))].filter(dir => fs.existsSync(dir))
    : resolveCatalogDirs({ env, projectRoot: input.projectRoot });
  const catalog = new RuntimeProviderCatalog({ now: input.now ?? (() => new Date()) });
  for (const dir of dirs) catalog.discover(dir);

  const runtime = { id: input.runtimeId, source: input.runtimeSource };
  const match = catalog.findRuntime(input.runtimeId);
  if (!match) return freeze({ runtime, provider: UNRESOLVED_PROVIDER, model: UNRESOLVED_MODEL, reason: NO_DESCRIPTOR_REASON });

  const providerId = String(match.provider.provider.id);
  const version = String(match.runtime.version || "unknown");
  const allowStale = input.allowStale ?? resolveSetting("runtime.allow_stale_catalog", { env, projectRoot: input.projectRoot }).value;
  const featuresRequired = input.requirements?.featuresRequired ?? [];
  const modelRequirements = input.requirements?.modelRequirements ?? {};
  const policy = { allowStale, featuresRequired, modelRequirements };
  const freshness = catalog.freshness(match.provider) as { stale: boolean; observedAt: string | null };
  const catalogInfo = { dirs, observedAt: freshness.observedAt, stale: freshness.stale };
  const unresolved = { runtime: { ...runtime, resolved: false, version }, provider: { id: providerId, resolved: false }, model: UNRESOLVED_MODEL };

  if (freshness.stale && !allowStale) {
    return freeze({ ...unresolved, catalog: catalogInfo, policy, warnings: [
      `Provider '${providerId}' model catalog is stale (observed at ${freshness.observedAt}); runtime and model stay unresolved. Set ${ALLOW_STALE_ENV}=1 (or nrv config set runtime.allow_stale_catalog true) to accept stale data.`,
    ] });
  }

  const result = new RuntimeBroker(catalog, new ModelBroker(catalog)).evaluateActive(input.runtimeId, {
    featuresRequired, modelRequirements: { ...modelRequirements, allowStale },
  });
  if (!result.compatible) {
    return freeze({ ...unresolved, catalog: catalogInfo, policy, errors: result.errors,
      rejected: result.rejectedModels ?? [], ...nonEmpty("degradations", result.degradations), ...nonEmpty("warnings", result.warnings) });
  }
  return freeze({
    runtime: { ...runtime, resolved: true, version },
    provider: { id: String(result.selected.provider), resolved: true },
    model: { id: String(result.selected.model), resolved: true },
    evidence: result.evidenceSnapshot, catalog: catalogInfo, policy,
    ...nonEmpty("degradations", result.degradations), ...nonEmpty("warnings", result.warnings),
  });
}
