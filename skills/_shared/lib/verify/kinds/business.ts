// kinds/business.ts — the business catalog of the admission gate.
//
// The table in §16.2 of `skills/businesses/BUSINESS_PROTOCOL_V2.md` IS this
// catalog: same ids, same severities, same autofix classes, same baselineable
// flags, checked by `skills/businesses/tests/protocol-v2-spec-parity.test.ts`.
// A criterion here without a row there — or a row there without a criterion
// here — fails that test. Write the row and the criterion in the same commit.
//
// Facts that shaped it (installed library, 61 businesses and 581 seats,
// 2026-08-26): every manifest and every seat already passes the Zod schema, so
// nothing in the catalog is about malformed YAML — the findings are about
// surface the protocol retired and semantics nobody implemented. 566 seats
// declare a `self_score_contract` no code reads, 475 a `heartbeat` no scheduler
// ever ran, 30 manifests and 201 seats an empty `squads_authorized` that the
// spec read as "every squad" and the prompt read as "no squad", 61 an
// `employee_count` the registry recomputes anyway, 7 manifests keep
// `auto_routes` in the wrong file, and 38 businesses ship no README at all.
//
// **The gate reads; the fixers write.** Every mechanical repair lives in
// `skills/businesses/lib/business-fixers.js` (CJS, like the squad side), so the
// audit scorer's `fixable_diff` kinds and the gate's `--fix` loop apply the
// same code. What a fixer cannot derive from the files stays a finding: no
// fixer writes a `not_for`, an `example_brief` or an acceptance criterion.
//
// **No `info` criterion.** The mind-clone module signals a skipped
// self-retrieval axis with severity `info`; here the axis is simply skipped
// when the business is not in the registry, because §16.2 declares errors and
// warnings only and this module must equal it.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { BusinessManifestSchema, EmployeeFrontmatterSchema, OrgChartSchema } from "../../../validators/validators.ts";
import { readFrontmatter, employeeFiles } from "../../frontmatter-edit.ts";
import { refToSlug, slugOf } from "../../entity-graph.ts";
import { classify } from "../../corpus-language.ts";
import { eventFindings } from "../../audit-events.ts";
import { fixResult, listEntities, resolveEntityDir, surfaceFindings, surfaceRegenFixer } from "../common.ts";
import type { CheckContext, Criterion, Finding, FixResult, Fixer, KindModule } from "../types.ts";

const require_ = createRequire(import.meta.url);
const BUSINESS_LIB = path.join(import.meta.dir, "..", "..", "..", "..", "businesses", "lib");
const fixers = require_(path.join(BUSINESS_LIB, "business-fixers.js")) as {
  applyBusinessFixes(dir: string, diff: { patches: Array<Record<string, unknown>> }): Array<{ kind: string; result: any }>;
  FIX_ORDER: string[];
  DEPRECATED_FIELDS: Record<string, string[]>;
};
const outputsLint = require_(path.join(import.meta.dir, "..", "..", "outputs-lint.js")) as {
  lintDir(dir: string): { errors: string[]; warnings: string[] };
};
const seatSufficiency = require_(path.join(import.meta.dir, "..", "..", "seat-sufficiency.js")) as {
  sufficiencyOfFile(content: string): { verdict: "sufficient" | "thin" };
};

/** A description shorter than this carries no routing signal (audit c6). */
const DESCRIPTION_MIN_CHARS = 100;
/** A README under this many lines is the scaffold, not the document (audit c9). */
const README_MIN_LINES = 40;
/** §6.9: three example briefs, at least one EN and one PT. */
const EXAMPLE_BRIEFS_MIN = 3;
/** BP7: above this many seats a business needs an antagonist. */
const ANTAGONIST_FLOOR = 5;

/** §13.2: a pattern that matches every brief turns routing off. */
const CATCH_ALL = new Set([".*", ".+", "(?i).*", "(?i).+", "^.*$", "^.+$", "(?i)^.*$", "(?i)^.+$", ".*?"]);

/** §22, with the destination each one has. `null` = removed, no conversion. */
const RETIRED_EMPLOYEE_FIELDS: Record<string, string | null> = {
  heartbeat: "heartbeat_strip",
  self_score_contract: "acceptance_from_self_score",
  draws_from: "draws_from_to_assigned",
  dna_reference: "dna_reference_to_pin",
  budget_monthly_usd: null, mentions: null, escalation_triggers: null,
  disclosure_template: null, default_tools: null, project_tool_overrides: null,
};
const RETIRED_MANIFEST_FIELDS = ["capabilities_required", "default_tools", "project_tool_overrides", "tickets", "ticket_intake", "disclosure_template"];
const RETIRED_ROUTING_FIELDS = ["mention_routing", "ticket_intake"];
const RETIRED_ROUTE_FIELDS = ["confidence_threshold", "requires_escalation_to"];
/**
 * The keys §13.2 gives a route. A seat name under one of these is that field
 * doing its own job — `requires_escalation_to` holds a seat in 66 routes of the
 * installed library and means escalation, never destination — so none of them
 * is ever read as a misspelled `route_to`.
 */
const KNOWN_ROUTE_FIELDS = new Set(["pattern", "patterns", "route_to", ...RETIRED_ROUTE_FIELDS]);
/** §5.3 / §22: reported, never deleted. */
const RETIRED_FILES = ["culture.md", "budgets.yaml", "secrets-manifest.yaml", "escalation-triggers.yaml", "approval-chains.yaml", "tickets", "processes"];

export const criteria: Criterion[] = [
  // ── errors ────────────────────────────────────────────────────────────────
  { id: "manifest_parse", severity: "error", autofix: "none", baselineable: false, title: "business.yaml exists and is valid YAML" },
  { id: "manifest_schema", severity: "error", autofix: "mechanical", baselineable: false, title: "the manifest passes BusinessManifestSchema", fixer: "manifest_schema_repair" },
  { id: "protocol_unsupported", severity: "error", autofix: "none", baselineable: false, title: "protocol is 1.0 or 2.0" },
  { id: "employees_present", severity: "error", autofix: "none", baselineable: false, title: "employees/ exists with at least one .md" },
  { id: "employee_frontmatter_invalid", severity: "error", autofix: "mechanical", baselineable: false, title: "every frontmatter passes EmployeeFrontmatterSchema", fixer: "employee_frontmatter_repair" },
  { id: "intake_exactly_one", severity: "error", autofix: "mechanical", baselineable: false, title: "exactly one employee declares is_brief_intake", fixer: "intake_from_chart_root" },
  { id: "org_chart_missing", severity: "error", autofix: "mechanical", baselineable: false, title: "org-chart.yaml exists", fixer: "org_chart_repair" },
  { id: "org_chart_inconsistent", severity: "error", autofix: "mechanical", baselineable: false, title: "every node exists in employees/, reporting is bidirectional, no cycle", fixer: "org_chart_repair" },
  { id: "antagonist_bp7", severity: "error", autofix: "none", baselineable: false, title: `BP7: more than ${ANTAGONIST_FLOOR} employees require an antagonist` },
  { id: "auto_route_unknown_employee", severity: "error", autofix: "none", baselineable: false, title: "every route_to names an existing employee" },
  { id: "auto_route_in_manifest", severity: "error", autofix: "mechanical", baselineable: false, title: "auto_routes is not in business.yaml", fixer: "auto_routes_relocate" },
  { id: "pinned_clone_unresolved", severity: "error", autofix: "none", baselineable: false, title: "every pinned_mind_clones entry resolves in the library" },
  { id: "acceptance_invalid", severity: "error", autofix: "mechanical", baselineable: false, title: "acceptance ids are valid and unique in the business; minimum_score in 0..1", fixer: "acceptance_normalize" },
  { id: "surface_missing", severity: "error", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json present", fixer: "surface_regen" },
  { id: "dna_symlink_dangling", severity: "error", autofix: "none", baselineable: false, title: "no dna/ symlink points at a target that is gone" },
  { id: "outputs_pollution", severity: "error", autofix: "none", baselineable: false, title: "no run-output directory inside the business" },
  // The audit contract, on the half of it that lives in content. Error so a
  // new violation cannot enter; baselineable so what already violates it
  // becomes recorded debt. Header of `_shared/lib/audit-events.ts` for why a
  // file scan sees a fraction of what the log holds.
  { id: "audit_event_unprefixed", severity: "error", autofix: "none", baselineable: true, title: "every audit event a file names is in the closed enum or carries the `x_` prefix" },
  { id: "audit_event_unattributed", severity: "error", autofix: "none", baselineable: true, title: "every `x_` event the business emits names the business" },

  // ── warnings ──────────────────────────────────────────────────────────────
  { id: "protocol_v1", severity: "warning", autofix: "mechanical", baselineable: false, title: "the business still declares protocol 1.0", fixer: "protocol_bump_2" },
  { id: "employee_count_authored", severity: "warning", autofix: "mechanical", baselineable: false, title: "employee_count declared in the manifest (§6.12)", fixer: "employee_count_strip" },
  { id: "deprecated_field", severity: "warning", autofix: "mechanical", baselineable: false, title: "a retired field is declared (`:<name>` says which)", fixer: "deprecated_field_strip" },
  { id: "deprecated_file", severity: "warning", autofix: "none", baselineable: false, title: "a retired file is present (`:<name>` says which)" },
  { id: "squads_authorized_empty", severity: "warning", autofix: "mechanical", baselineable: false, title: "squads_authorized: [] declared (§6.10)", fixer: "squads_authorized_empty_strip" },
  { id: "squads_ref_unknown", severity: "warning", autofix: "none", baselineable: false, title: "a squad named in preferred/authorized is not in the library" },
  { id: "acceptance_missing", severity: "warning", autofix: "agentic", baselineable: false, title: "the intake seat declares no acceptance" },
  { id: "routing_metadata_incomplete", severity: "warning", autofix: "agentic", baselineable: false, title: "one of the four §6.9 fields is missing or truncated" },
  { id: "description_short", severity: "warning", autofix: "agentic", baselineable: false, title: "description too short to carry routing signal" },
  { id: "auto_route_never_fires", severity: "warning", autofix: "none", baselineable: false, title: "a pattern fires against no example_brief of the business" },
  { id: "auto_route_catch_all", severity: "warning", autofix: "mechanical", baselineable: false, title: "a pattern matches everything (§13.2)", fixer: "catch_all_to_default_employee" },
  { id: "seat_thin", severity: "warning", autofix: "agentic", baselineable: true, title: "a seat carries too little method of its own" },
  { id: "self_retrieval_miss", severity: "warning", autofix: "agentic", baselineable: true, title: "an example_brief does not return the business in top-1" },
  { id: "readme_missing", severity: "warning", autofix: "mechanical", baselineable: false, title: "README.md absent", fixer: "readme_business_scaffold" },
  { id: "readme_thin", severity: "warning", autofix: "agentic", baselineable: false, title: "README.md holds nothing beyond the skeleton" },
  { id: "memory_inside_entity", severity: "warning", autofix: "none", baselineable: false, title: "memory accumulated inside the business instead of .nirvana" },
  { id: "runtime_requirements_default", severity: "warning", autofix: "mechanical", baselineable: false, title: "runtime_requirements is still the template skeleton", fixer: "runtime_requirements_business_default" },
  { id: "type_mind_clone_without_pin", severity: "warning", autofix: "none", baselineable: false, title: "type: mind_clone without pinned_mind_clones (§7.8)" },
  { id: "type_flag_mismatch", severity: "warning", autofix: "mechanical", baselineable: false, title: "type: antagonist_gate without is_antagonist: true (§7.8)", fixer: "type_flag_sync" },
  { id: "dna_dir_present", severity: "warning", autofix: "mechanical", baselineable: false, title: "a dna/ directory is present (§5.3)", fixer: "dna_dir_to_bindings" },
  { id: "surface_stale", severity: "warning", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json differs from the extraction", fixer: "surface_regen" },
  { id: "operation_mode_unsupported", severity: "warning", autofix: "none", baselineable: false, title: "operation_mode other than zero_human, not honored this cycle" },
  { id: "legacy_partial", severity: "warning", autofix: "none", baselineable: false, title: "the legacy block is present and incomplete" },
];

const BY_ID = new Map(criteria.map((c) => [c.id, c]));

/** A finding of one criterion. `fixer` overrides the criterion's default —
 *  `deprecated_field:heartbeat` and `deprecated_field:mentions` are the same
 *  criterion repaired by two different handlers. */
function mk(id: string, message: string, evidence: string, where?: string, fixer?: string | null): Finding {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown business criterion: ${id}`);
  const chosen = fixer === undefined ? c.fixer : fixer;
  return {
    id, severity: c.severity, autofix: c.autofix, message, evidence,
    ...(where ? { where } : {}), baselined: false, ...(chosen ? { fixer: chosen } : {}),
  };
}

// ── measurements ────────────────────────────────────────────────────────────

const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const manifestOf = (dir: string) => path.join(dir, "business.yaml");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface SeatRead {
  file: string;
  stem: string;
  name: string;
  /** null when the file carries no frontmatter block at all. */
  data: Record<string, unknown> | null;
  frontmatterMissing: boolean;
  parseError: string | null;
  body: string;
}

export interface BusinessRead {
  manifest: Record<string, unknown> | null;
  parseError: string | null;
  /** `protocol` as declared, with an unquoted YAML number rendered as `x.0`. */
  protocol: string;
  seats: SeatRead[];
  employeesDirMissing: boolean;
  chart: Record<string, unknown> | null;
  chartMissing: boolean;
  chartParseError: string | null;
  routing: Record<string, unknown> | null;
  routingParseError: string | null;
}

function readYamlFile(file: string): { data: Record<string, unknown> | null; error: string | null; missing: boolean } {
  if (!fs.existsSync(file)) return { data: null, error: null, missing: true };
  try {
    const doc = parseYaml(fs.readFileSync(file, "utf8"), { uniqueKeys: false });
    if (!isMapping(doc)) return { data: null, error: `not a YAML mapping (${Array.isArray(doc) ? "array" : typeof doc})`, missing: false };
    return { data: doc, error: null, missing: false };
  } catch (e: any) {
    return { data: null, error: String(e?.message ?? e).split("\n")[0], missing: false };
  }
}

export function readBusiness(dir: string): BusinessRead {
  const m = readYamlFile(manifestOf(dir));
  const chart = readYamlFile(path.join(dir, "org-chart.yaml"));
  const routing = readYamlFile(path.join(dir, "routing.yaml"));
  const files = employeeFiles(dir);
  const seats: SeatRead[] = files.map((file) => {
    const stem = path.basename(file).replace(/\.md$/, "");
    const fm = readFrontmatter(file);
    return {
      file, stem,
      name: fm && typeof fm.data.name === "string" ? fm.data.name : stem,
      data: fm && fm.doc ? fm.data : null,
      frontmatterMissing: fm === null,
      parseError: fm ? fm.parseError : null,
      body: fm ? fm.body : (() => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } })(),
    };
  });
  const rawProtocol = m.data?.protocol;
  return {
    manifest: m.data,
    parseError: m.missing ? "business.yaml is absent" : m.error,
    protocol: typeof rawProtocol === "number" ? rawProtocol.toFixed(1) : String(rawProtocol ?? "").trim(),
    seats,
    employeesDirMissing: !fs.existsSync(path.join(dir, "employees")),
    chart: chart.data,
    chartMissing: chart.missing,
    chartParseError: chart.error,
    routing: routing.data,
    routingParseError: routing.error,
  };
}

/** Every auto_route the business declares, from both files (§13.2). */
function autoRoutes(b: BusinessRead): Array<{ pattern: string; route_to: string; source: "routing.yaml" | "business.yaml"; raw: Record<string, unknown> }> {
  const out: Array<{ pattern: string; route_to: string; source: "routing.yaml" | "business.yaml"; raw: Record<string, unknown> }> = [];
  for (const [source, holder] of [["routing.yaml", b.routing], ["business.yaml", b.manifest]] as const) {
    for (const r of (Array.isArray(holder?.auto_routes) ? holder!.auto_routes : []) as unknown[]) {
      if (!isMapping(r)) continue;
      out.push({ pattern: String(r.pattern ?? ""), route_to: String(r.route_to ?? ""), source, raw: r });
    }
  }
  return out;
}

/** Compiles a router pattern the way router.js does: `(?i)` becomes the flag. */
function compilePattern(pattern: string): RegExp | null {
  try {
    const ci = pattern.startsWith("(?i)");
    return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "i" : "");
  } catch { return null; }
}

function cloneSlugOf(ref: string): string | null {
  const viaLibrary = refToSlug(ref);
  const last = slugOf(ref.replace(/\/+$/, "")).replace(/\.(md|markdown)$/i, "");
  const slug = /(^|\/)dna\//.test(ref) && viaLibrary ? viaLibrary : last;
  return slug && !/\.(md|ya?ml|json)$/i.test(slug) ? slug : null;
}

function installedSlugs(kind: "squad" | "mind-clone"): Set<string> {
  try { return new Set(listEntities(kind).map((e) => e.slug)); } catch { return new Set(); }
}

// ── the check ───────────────────────────────────────────────────────────────

/**
 * Everything the gate can decide from the files alone. `check` adds the one
 * axis that needs the registry (self-retrieval); `protocol_bump_2` consults
 * this function to refuse a version bump while an error is still open.
 */
export function checkSync(dir: string): Finding[] {
  const out: Finding[] = [];
  const b = readBusiness(dir);

  // ── the manifest ──────────────────────────────────────────────────────────
  if (!b.manifest) {
    out.push(mk("manifest_parse", `business.yaml does not load: ${b.parseError ?? "unknown reason"}`, manifestOf(dir)));
  } else {
    const parsed = BusinessManifestSchema.safeParse(b.manifest);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      out.push(mk("manifest_schema", `the manifest fails BusinessManifestSchema (${issues.length} issue${issues.length === 1 ? "" : "s"})`, issues.slice(0, 3).join(" · ")));
    }
    if (b.protocol && b.protocol !== "1.0" && b.protocol !== "2.0") {
      out.push(mk("protocol_unsupported", `protocol ${b.protocol} is not a version this engine loads`, "expected 1.0 or 2.0"));
    }
    if (b.protocol === "1.0") out.push(mk("protocol_v1", "still Business Protocol 1.0 — the v2 rules apply as advice until the version rises", "protocol: \"1.0\""));
    if ("employee_count" in b.manifest) {
      out.push(mk("employee_count_authored", `employee_count is derived from employees/*.md (§6.12); the declared ${String(b.manifest.employee_count)} is decoration`, `${b.seats.length} file(s) on disk`));
    }
    if ("auto_routes" in b.manifest) {
      const n = Array.isArray(b.manifest.auto_routes) ? b.manifest.auto_routes.length : 0;
      out.push(mk("auto_route_in_manifest", `${n} auto_route(s) live in business.yaml; §13.2 puts them in routing.yaml`, "business.yaml.auto_routes"));
    }
    const description = String(b.manifest.description ?? "").trim();
    if (description.length < DESCRIPTION_MIN_CHARS) {
      out.push(mk("description_short", `description is ${description.length} chars — under ${DESCRIPTION_MIN_CHARS} it carries almost no BM25 signal`, description.slice(0, 60)));
    }
    const rr = b.manifest.runtime_requirements;
    const hasFloor = isMapping(rr) && (rr.policy === "active" || (Array.isArray(rr.minimum) && rr.minimum.length > 0));
    if (!hasFloor) out.push(mk("runtime_requirements_default", "runtime_requirements declares no minimum and does not follow the active runtime", isMapping(rr) ? `policy: ${String(rr.policy)}` : "absent"));
    if (b.manifest.operation_mode !== undefined && b.manifest.operation_mode !== "zero_human") {
      out.push(mk("operation_mode_unsupported", `operation_mode ${String(b.manifest.operation_mode)} is declared but not honored this cycle — the engine runs zero_human`, "business.yaml.operation_mode"));
    }
    if (isMapping(b.manifest.legacy)) {
      const l = b.manifest.legacy;
      if (typeof l.paperclip_instance !== "string" || typeof l.paperclip_data_dir !== "string") {
        out.push(mk("legacy_partial", "the legacy block names no instance or no data dir, so the migration cannot be traced", Object.keys(l).join(", ") || "(empty)"));
      }
    }
    out.push(...routingMetadata(b.manifest));
  }

  // ── the seats ─────────────────────────────────────────────────────────────
  if (b.employeesDirMissing) out.push(mk("employees_present", "employees/ is absent — a business with no seat cannot receive a brief", path.join(dir, "employees")));
  else if (b.seats.length === 0) out.push(mk("employees_present", "employees/ holds no .md file", path.join(dir, "employees")));

  const names = new Set(b.seats.map((s) => s.name));
  for (const seat of b.seats) {
    if (seat.frontmatterMissing) {
      out.push(mk("employee_frontmatter_invalid", `${seat.stem}.md has no frontmatter block`, seat.file, seat.stem));
      continue;
    }
    if (!seat.data) {
      out.push(mk("employee_frontmatter_invalid", `${seat.stem}.md frontmatter does not parse: ${seat.parseError ?? "unknown reason"}`, seat.file, seat.stem, null));
      continue;
    }
    const parsed = EmployeeFrontmatterSchema.safeParse(seat.data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      out.push(mk("employee_frontmatter_invalid", `${seat.stem}.md fails EmployeeFrontmatterSchema`, issues.slice(0, 2).join(" · "), seat.stem, null));
    }
    if (seat.data.type === "mind_clone" && strings(seat.data.pinned_mind_clones).length === 0) {
      out.push(mk("type_mind_clone_without_pin", `${seat.name} is typed mind_clone and pins no clone — the seat promises a voice it cannot guarantee`, "pinned_mind_clones", seat.stem));
    }
    if (seat.data.type === "antagonist_gate" && seat.data.is_antagonist !== true) {
      out.push(mk("type_flag_mismatch", `${seat.name} is typed antagonist_gate without is_antagonist: true`, "is_antagonist", seat.stem));
    }
    if (seatSufficiency.sufficiencyOfFile(fs.readFileSync(seat.file, "utf8")).verdict === "thin") {
      // `employees/<file>.md`, not the seat name: this is the key
      // `baseline.importLegacy` writes when it converts a `.seat-sufficiency-
      // baseline.json` entry, and recorded debt must survive the import.
      out.push(mk("seat_thin", `${seat.name} carries too little method of its own to stand without a clone`, `${seat.body.trim().length} chars of body`, `employees/${path.basename(seat.file)}`));
    }
  }

  const intakes = b.seats.filter((s) => s.data?.is_brief_intake === true);
  if (b.seats.length > 0 && intakes.length !== 1) {
    out.push(mk("intake_exactly_one", `${intakes.length} seat(s) declare is_brief_intake: true; a business receives a brief at exactly one`,
      intakes.map((s) => s.name).join(", ") || "(none)", undefined, intakes.length === 0 ? "intake_from_chart_root" : null));
  }
  if (intakes.length === 1 && !(Array.isArray(intakes[0].data!.acceptance) && (intakes[0].data!.acceptance as unknown[]).length > 0)) {
    out.push(mk("acceptance_missing", `the intake seat ${intakes[0].name} declares no acceptance — nothing tells the judge what the deliverable must satisfy`, "employees/" + intakes[0].stem + ".md"));
  }
  if (b.seats.length > ANTAGONIST_FLOOR && !b.seats.some((s) => s.data?.is_antagonist === true)) {
    out.push(mk("antagonist_bp7", `${b.seats.length} seats and no antagonist: BP7 requires adversarial review above ${ANTAGONIST_FLOOR}`, "is_antagonist"));
  }

  out.push(...acceptanceFindings(b));
  out.push(...deprecatedFindings(dir, b));
  out.push(...chartFindings(b));
  out.push(...routeFindings(b, names));
  out.push(...squadRefFindings(b));
  out.push(...cloneFindings(dir, b));
  out.push(...fileFindings(dir, b));

  out.push(...surfaceFindings(dir, "business", (id, message, evidence) => mk(id, message, evidence)));
  for (const e of outputsLint.lintDir(dir).errors) out.push(mk("outputs_pollution", e, dir));
  for (const f of eventFindings(dir, "business")) out.push(mk(f.id, f.message, f.evidence, f.where));
  return out;
}

/** §6.9: the four fields the router reads off the manifest. */
function routingMetadata(manifest: Record<string, unknown>): Finding[] {
  const missing: string[] = [];
  if (strings(manifest.produces).length === 0) missing.push("produces");
  if (strings(manifest.keywords).length === 0) missing.push("keywords");
  const briefs = strings(manifest.example_briefs);
  if (briefs.length < EXAMPLE_BRIEFS_MIN) missing.push(`example_briefs (${briefs.length}/${EXAMPLE_BRIEFS_MIN})`);
  else {
    const langs = new Set(briefs.map(classify));
    if (!langs.has("en") || !langs.has("pt")) missing.push(`example_briefs in both EN and PT (found ${[...langs].sort().join("+") || "none"})`);
  }
  if (strings(manifest.not_for).length === 0) missing.push("not_for");
  return missing.length ? [mk("routing_metadata_incomplete", "the business is missing routing metadata the router reads (§6.9)", missing.join(" · "))] : [];
}

/** §11: ids match the pattern, are unique in the business, scores are in 0..1. */
function acceptanceFindings(b: BusinessRead): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, string>();
  const ID = /^[a-z][a-z0-9_-]*$/;
  for (const seat of b.seats) {
    for (const entry of (Array.isArray(seat.data?.acceptance) ? seat.data!.acceptance : []) as unknown[]) {
      if (!isMapping(entry)) { out.push(mk("acceptance_invalid", `${seat.name}: an acceptance entry is not a mapping`, String(entry).slice(0, 40), seat.stem)); continue; }
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!ID.test(id)) out.push(mk("acceptance_invalid", `${seat.name}: acceptance id ${JSON.stringify(id)} does not match ^[a-z][a-z0-9_-]*$`, "id", `${seat.stem}:${id || "(unnamed)"}`));
      else if (seen.has(id)) out.push(mk("acceptance_invalid", `${seat.name}: acceptance id ${id} is already declared by ${seen.get(id)} — ids are unique inside the business`, "id", `${seat.stem}:${id}`));
      else seen.set(id, seat.name);
      if (entry.minimum_score !== undefined) {
        const n = typeof entry.minimum_score === "number" ? entry.minimum_score : Number(entry.minimum_score);
        if (!Number.isFinite(n) || n < 0 || n > 1) out.push(mk("acceptance_invalid", `${seat.name}: minimum_score ${String(entry.minimum_score)} is outside 0..1`, "minimum_score", `${seat.stem}:${id || "(unnamed)"}`));
      }
    }
  }
  return out;
}

/** §22: every retired field, wherever it is declared, with its destination. */
function deprecatedFindings(dir: string, b: BusinessRead): Finding[] {
  const out: Finding[] = [];
  const seats = new Map<string, string[]>();
  for (const seat of b.seats) {
    for (const field of Object.keys(RETIRED_EMPLOYEE_FIELDS)) {
      if (seat.data && field in seat.data) seats.set(field, [...(seats.get(field) ?? []), seat.name]);
    }
    if (seat.data && (seat.data.squads_authorized === null || (Array.isArray(seat.data.squads_authorized) && seat.data.squads_authorized.length === 0))) {
      seats.set("__empty_authorized", [...(seats.get("__empty_authorized") ?? []), seat.name]);
    }
  }
  for (const [field, where] of seats) {
    if (field === "__empty_authorized") continue;
    const fixer = RETIRED_EMPLOYEE_FIELDS[field] ?? "deprecated_field_strip";
    const destination = RETIRED_EMPLOYEE_FIELDS[field] ? "converted by --fix" : "removed by --fix";
    out.push(mk("deprecated_field", `${where.length} seat(s) declare ${field}, retired in v2 (§22) — ${destination}`, where.slice(0, 4).join(", "), field, fixer));
  }
  for (const field of RETIRED_MANIFEST_FIELDS) {
    if (b.manifest && field in b.manifest) out.push(mk("deprecated_field", `business.yaml declares ${field}, retired in v2 (§22)`, "business.yaml", field, "deprecated_field_strip"));
  }
  for (const field of RETIRED_ROUTING_FIELDS) {
    if (b.routing && field in b.routing) out.push(mk("deprecated_field", `routing.yaml declares ${field}, retired in v2 (§22)`, "routing.yaml", field, "deprecated_field_strip"));
  }
  for (const field of RETIRED_ROUTE_FIELDS) {
    const hits = autoRoutes(b).filter((r) => field in r.raw);
    if (hits.length) out.push(mk("deprecated_field", `${hits.length} auto_route(s) declare ${field}, retired in v2 (§13.2) — nothing ever read it`, hits[0].pattern.slice(0, 40), field, "deprecated_field_strip"));
  }

  // §6.10: the empty list the spec and the prompt read in opposite directions.
  const manifestEmpty = b.manifest && (b.manifest.squads_authorized === null || (Array.isArray(b.manifest.squads_authorized) && b.manifest.squads_authorized.length === 0));
  const seatsEmpty = seats.get("__empty_authorized") ?? [];
  if (manifestEmpty || seatsEmpty.length) {
    const where = [...(manifestEmpty ? ["business.yaml"] : []), ...seatsEmpty];
    out.push(mk("squads_authorized_empty", `${where.length} declaration(s) of squads_authorized: [] — empty means every squad (§6.10), and --fix removes the line`, where.slice(0, 4).join(", ")));
  }
  for (const file of RETIRED_FILES) {
    if (fs.existsSync(path.join(dir, file))) out.push(mk("deprecated_file", `${file} is retired in v2 (§22) — reported, never deleted`, path.join(dir, file), file));
  }
  return out;
}

/** §5.3: the chart is a graph over the seats, consistent in both directions. */
function chartFindings(b: BusinessRead): Finding[] {
  const out: Finding[] = [];
  if (b.chartMissing) return [mk("org_chart_missing", "org-chart.yaml is absent — the hierarchy the team mode walks has no file", "org-chart.yaml")];
  if (!b.chart) return [mk("org_chart_inconsistent", `org-chart.yaml does not load: ${b.chartParseError ?? "unknown reason"}`, "org-chart.yaml")];
  const parsed = OrgChartSchema.safeParse(b.chart);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    out.push(mk("org_chart_inconsistent", "org-chart.yaml fails OrgChartSchema", issues.slice(0, 2).join(" · ")));
  }
  const chart = (Array.isArray(b.chart.chart) ? b.chart.chart : []).filter(isMapping);
  if (chart.length === 0) return out;                                  // the `org:` layout exposes no graph
  const names = new Set(b.seats.map((s) => s.name));
  const nodeOf = new Map(chart.map((n) => [String(n.employee), n]));
  const problems: string[] = [];
  for (const node of chart) {
    const who = String(node.employee);
    if (!names.has(who)) problems.push(`${who} has no employees/*.md`);
    for (const up of strings(node.reports)) if (!names.has(up)) problems.push(`${who} reports to unknown ${up}`);
    for (const down of strings(node.direct_reports)) {
      if (!names.has(down)) { problems.push(`${who} manages unknown ${down}`); continue; }
      const child = nodeOf.get(down);
      if (child && !strings(child.reports).includes(who)) problems.push(`${who} manages ${down} but ${down} does not report back`);
    }
  }
  const seen = new Set<string>(), stack = new Set<string>();
  const cycles = (who: string): boolean => {
    if (stack.has(who)) return true;
    if (seen.has(who)) return false;
    seen.add(who); stack.add(who);
    for (const down of strings(nodeOf.get(who)?.direct_reports)) if (cycles(down)) return true;
    stack.delete(who);
    return false;
  };
  for (const node of chart) if (cycles(String(node.employee))) { problems.push(`the chart cycles through ${String(node.employee)}`); break; }
  if (problems.length) out.push(mk("org_chart_inconsistent", `${problems.length} inconsistenc${problems.length === 1 ? "y" : "ies"} between org-chart.yaml and employees/`, problems.slice(0, 3).join(" · ")));
  return out;
}

/**
 * Why a route names no seat, in the reader's terms. Two cases the old message
 * collapsed into one, at the cost of an audit: `investigation-bureau` carried a
 * whole route table whose seats sat under the key `employee:`, and the gate
 * answered `route_to (empty) names no seat` on every one of them, printing a
 * placeholder where a seat name belongs and blaming a name nobody had written.
 *
 * The engine has no alias normalizer, by decision: this module reads
 * `r.route_to`, and `router.js` skips any entry whose `route_to` is not a
 * string. A route under another key is dropped on both sides, silently, and the
 * message is the only place that fact can reach the person fixing it. No second
 * spelling of the field is accepted anywhere; naming the key is the whole fix.
 */
function unusableRouteTo(raw: Record<string, unknown>, coerced: string, names: Set<string>): string {
  const declared = raw.route_to;
  if (typeof declared === "string" && declared.trim() !== "") return `route_to ${coerced} names no seat of this business`;
  if (declared !== undefined && typeof declared !== "string") {
    return `route_to is a ${Array.isArray(declared) ? "list" : typeof declared}, not a string — the router skips every route whose route_to is not a string`;
  }
  const state = "route_to" in raw ? "route_to is empty" : "route_to is absent";
  const misplaced = Object.entries(raw).filter(([k, v]) => !KNOWN_ROUTE_FIELDS.has(k) && typeof v === "string" && names.has(v)) as Array<[string, string]>;
  const dead = "Both the gate and the router read route_to only, so this route is dead in both";
  if (misplaced.length === 1) {
    const [key, seat] = misplaced[0];
    return `${state}: the key ${key} holds ${seat}, a seat of this business. ${dead} — rename the key to route_to.`;
  }
  if (misplaced.length > 1) {
    const pairs = misplaced.map(([k, v]) => `${k}: ${v}`).join(", ");
    return `${state}: ${misplaced.length} keys hold a seat name (${pairs}). ${dead} — which key was meant is the author's call.`;
  }
  return `${state} — both the gate and the router drop a route that does not name a seat.`;
}

/** §13.2: routes name a seat, fire against a real brief, and never match all. */
function routeFindings(b: BusinessRead, names: Set<string>): Finding[] {
  const out: Finding[] = [];
  const routes = autoRoutes(b);
  if (routes.length === 0) return out;
  const briefs = strings(b.manifest?.example_briefs);
  for (const r of routes) {
    const label = r.pattern.slice(0, 48) || "(empty)";
    if (!names.has(r.route_to)) {
      out.push(mk("auto_route_unknown_employee", unusableRouteTo(r.raw, r.route_to, names), `${r.source}: ${label}`, r.route_to || label));
      continue;
    }
    if (CATCH_ALL.has(r.pattern.trim())) {
      out.push(mk("auto_route_catch_all", `pattern ${label} matches every brief, so it is ignored and every specific route below it never runs`, `${r.source} → ${r.route_to}`, label));
      continue;
    }
    const re = compilePattern(r.pattern);
    if (!re) { out.push(mk("auto_route_never_fires", `pattern ${label} is not a regex this engine compiles`, r.source, label)); continue; }
    if (briefs.length && !briefs.some((brief) => re.test(brief))) {
      out.push(mk("auto_route_never_fires", `pattern ${label} fires against none of the ${briefs.length} example_briefs of the business`, `${r.source} → ${r.route_to}`, label));
    }
  }
  return out;
}

/** §6.10: a squad named in a preference or a fence has to exist. */
function squadRefFindings(b: BusinessRead): Finding[] {
  const declared = new Map<string, string[]>();
  const add = (slug: string, where: string) => declared.set(slug, [...(declared.get(slug) ?? []), where]);
  for (const key of ["squads_preferred", "squads_authorized"]) {
    for (const s of strings(b.manifest?.[key])) add(s, `business.yaml.${key}`);
    for (const seat of b.seats) for (const s of strings(seat.data?.[key])) add(s, `${seat.name}.${key}`);
  }
  if (declared.size === 0) return [];
  const installed = installedSlugs("squad");
  if (installed.size === 0) return [];        // no library to compare against
  const out: Finding[] = [];
  for (const [slug, where] of declared) {
    if (installed.has(slug)) continue;
    out.push(mk("squads_ref_unknown", `${slug} is named by ${where.length} declaration(s) and is not installed`, where.slice(0, 3).join(", "), slug));
  }
  return out;
}

/** §7.7 / §5.3: pins resolve, and a dna/ symlink that broke is an error. */
function cloneFindings(dir: string, b: BusinessRead): Finding[] {
  const out: Finding[] = [];
  const pins = new Map<string, string[]>();
  for (const seat of b.seats) for (const p of strings(seat.data?.pinned_mind_clones)) {
    const slug = cloneSlugOf(p) ?? p;
    pins.set(slug, [...(pins.get(slug) ?? []), seat.name]);
  }
  if (pins.size) {
    const installed = installedSlugs("mind-clone");
    for (const [slug, seats] of pins) {
      if (installed.has(slug)) continue;
      out.push(mk("pinned_clone_unresolved", `${seats.join(", ")} pins ${slug}, which is not in the library — a seat that promises a voice must have it`, "pinned_mind_clones", slug));
    }
  }
  const dnaDir = path.join(dir, "dna");
  if (!fs.existsSync(dnaDir)) return out;
  const entries = (() => { try { return fs.readdirSync(dnaDir); } catch { return []; } })();
  for (const name of entries) {
    const full = path.join(dnaDir, name);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink() && !fs.existsSync(full)) {
      out.push(mk("dna_symlink_dangling", `dna/${name} points at a target that is gone — the binding already broke`, (() => { try { return fs.readlinkSync(full); } catch { return full; } })(), name));
    }
  }
  out.push(mk("dna_dir_present", `dna/ holds ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; symlinks do not travel in a pack, so §5.3 moves the binding into the frontmatter`, dnaDir));
  return out;
}

/** README and memory: the two files a business is expected to carry. */
function fileFindings(dir: string, b: BusinessRead): Finding[] {
  const out: Finding[] = [];
  const readme = ["README.md", "README.pt-BR.md"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!readme) out.push(mk("readme_missing", "no README.md — the one document a human opens first", path.join(dir, "README.md")));
  else {
    const text = fs.readFileSync(readme, "utf8");
    const lines = text.split("\n").length;
    const lower = text.toLowerCase();
    const groups = [["## "], ["employee", "funcionário", "cargo", "role"], ["usage", "uso", "como", "getting started"], ["domain", "domínio", "description", "descrição", "sobre"]];
    const covered = groups.filter((g) => g.some((kw) => lower.includes(kw))).length;
    if (lines < README_MIN_LINES || covered < 3) {
      out.push(mk("readme_thin", `${path.basename(readme)} is ${lines} line(s) and covers ${covered}/4 of the sections a reader looks for`, path.basename(readme)));
    }
  }
  // Accumulated memory inside the entity is the defect, not its absence: the
  // directory is replaced whole on update, so `learned.md` and `memory/projects`
  // are written where they cannot survive. They belong in `.nirvana`.
  const strayMemory = ["learned.md", "projects"].filter((n) => fs.existsSync(path.join(dir, "memory", n)));
  if (strayMemory.length) {
    out.push(mk("memory_inside_entity", `memory/${strayMemory.join(", memory/")} sits inside the business, where a pack update discards it — move it with \`nrv memory relocate --apply\``, path.join(dir, "memory")));
  }
  return out;
}

// ── self-retrieval ──────────────────────────────────────────────────────────

const MATCH_INDEX = new WeakMap<object, unknown>();
let REGISTRIES: any;

/**
 * ROUTING_METADATA_CONTRACT §9, one entity at a time: the business's own
 * `example_briefs` are put through the router with amplification off, and the
 * business has to come back first. The match index is built once per registry
 * object, so `--all` over 61 businesses builds one corpus, not 61.
 *
 * The axis is skipped — silently, §16.2 declares no `info` severity — when
 * retrieval is off, the registry is absent, or the business is not in it.
 */
async function selfRetrieval(ctx: CheckContext): Promise<Finding[]> {
  let registries: any = ctx.registries;
  if (!registries) {
    if (REGISTRIES === undefined) {
      try {
        const loader = require_(path.join(import.meta.dir, "..", "..", "..", "..", "harness", "lib", "registry-loader.js"));
        REGISTRIES = loader.loadAll();
      } catch { REGISTRIES = null; }
    }
    registries = REGISTRIES;
  }
  if (!registries?.businesses?.businesses?.[ctx.slug]) return [];
  const briefs = strings(readBusiness(ctx.dir).manifest?.example_briefs);
  if (briefs.length === 0) return [];

  const router = require_(path.join(import.meta.dir, "..", "..", "..", "..", "harness", "lib", "router.js"));
  let prepared = MATCH_INDEX.get(registries as object);
  if (!prepared) { prepared = router.prepareMatchIndex(registries); MATCH_INDEX.set(registries as object, prepared); }

  for (const brief of briefs) {
    const result = await router.route(brief, { registries, amplify: false, preparedMatchIndex: prepared });
    const s3 = result?.stage3 ?? {};
    const ranked = s3.signal === "HIGH" ? [s3.target, ...(s3.alternatives ?? [])].filter(Boolean)
      : s3.signal === "AMBIGUOUS" ? (s3.alternatives ?? []).filter(Boolean) : [];
    const hit = ranked.findIndex((c: any) => {
      const meta = c?.meta ?? {};
      return (meta.type === "business" || meta.type === "business_route") && meta.slug === ctx.slug;
    });
    if (hit === 0) continue;
    const top = ranked.slice(0, 3).map((c: any) => `${c?.meta?.slug ?? c?.id ?? "?"} (${typeof c?.normalized === "number" ? c.normalized.toFixed(2) : "-"})`).join(", ") || "no candidates";
    return [mk("self_retrieval_miss", `example_brief ${JSON.stringify(brief.slice(0, 48))} does not return this business first (rank ${hit === -1 ? "-" : hit + 1})`, `top: ${top}`)];
  }
  return [];
}

export async function check(ctx: CheckContext): Promise<Finding[]> {
  const out = checkSync(ctx.dir);
  if (ctx.retrieval) out.push(...await selfRetrieval(ctx));
  return out;
}

// ── fixers ──────────────────────────────────────────────────────────────────

/** Contract-surface paths a fixer touches; the digest that names changed files. */
const TRACKED = ["business.yaml", "org-chart.yaml", "routing.yaml", "README.md", "employees", "memory", "dna"];

function trackedDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (rel: string) => {
    const full = path.join(dir, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { return; }
    if (st.isSymbolicLink()) { out[rel] = "symlink"; return; }
    if (st.isFile()) { try { out[rel] = String(Bun.hash(fs.readFileSync(full))); } catch { /* unreadable */ } return; }
    if (!st.isDirectory()) return;
    for (const name of (() => { try { return fs.readdirSync(full); } catch { return []; } })()) add(path.posix.join(rel, name));
  };
  for (const rel of TRACKED) add(rel);
  return out;
}

/**
 * Runs one handler of `business-fixers.js` and reports which tracked files it
 * changed. A handler that declines (`ok: false`) is a note in the report, never
 * a thrown error: declining is how the gate says "this one needs a human".
 */
function delegate(kind: string, patchOf?: (f: Finding) => Record<string, unknown>): Fixer {
  return ({ dir, finding }): FixResult => {
    const before = trackedDigest(dir);
    const r = fixers.applyBusinessFixes(dir, { patches: [{ kind, criterion: finding.id, ...(patchOf ? patchOf(finding) : {}) }] })[0];
    const after = trackedDigest(dir);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
    const note = r?.result?.ok === false ? `declined: ${r.result.reason ?? "no reason given"}` : r?.result?.note ?? undefined;
    return { ...fixResult(kind, finding, changed.length > 0, changed), ...(note ? { note } : {}) };
  };
}

/**
 * §18.4: the version is an assertion about everything else, so it rises last
 * and only over a business with no error left. The guard re-runs the file-based
 * half of the catalog — the half a fixer can have changed — and declines while
 * anything is still an error.
 */
const protocolBump: Fixer = (ctx) => {
  const remaining = checkSync(ctx.dir).filter((f) => f.severity === "error");
  if (remaining.length) {
    return { ...fixResult("protocol_bump_2", ctx.finding, false, []), note: `declined: ${remaining.length} error(s) still open (${remaining.slice(0, 3).map((f) => f.id).join(", ")})` };
  }
  return delegate("protocol_bump_2")(ctx);
};

export const businessModule: KindModule = {
  kind: "business",
  manifestFile: "business.yaml",
  resolveDir: (target) => resolveEntityDir("business", target),
  listAll: (roots) => listEntities("business", roots),
  criteria,
  check,
  fixers: {
    employee_frontmatter_repair: delegate("employee_frontmatter_repair"),
    intake_from_chart_root: delegate("intake_from_chart_root"),
    type_flag_sync: delegate("type_flag_sync"),
    acceptance_from_self_score: delegate("acceptance_from_self_score"),
    acceptance_normalize: delegate("acceptance_normalize"),
    heartbeat_strip: delegate("heartbeat_strip"),
    // Both conversions bind a seat to a clone, so both are told which clones
    // the gate can see — the same set `pinned_clone_unresolved` judges against.
    draws_from_to_assigned: delegate("draws_from_to_assigned", () => ({ available_clones: [...installedSlugs("mind-clone")] })),
    dna_reference_to_pin: delegate("dna_reference_to_pin", () => ({ available_clones: [...installedSlugs("mind-clone")] })),
    deprecated_field_strip: delegate("deprecated_field_strip", (f) => ({ field: f.where })),
    squads_authorized_empty_strip: delegate("squads_authorized_empty_strip"),
    manifest_schema_repair: delegate("manifest_schema_repair"),
    employee_count_strip: delegate("employee_count_strip"),
    runtime_requirements_business_default: delegate("runtime_requirements_business_default"),
    org_chart_repair: delegate("org_chart_repair"),
    auto_routes_relocate: delegate("auto_routes_relocate"),
    catch_all_to_default_employee: delegate("catch_all_to_default_employee"),
    dna_dir_to_bindings: delegate("dna_dir_to_bindings"),
    readme_business_scaffold: delegate("readme_business_scaffold"),
    memory_seed: delegate("memory_seed"),
    surface_regen: surfaceRegenFixer("business"),
    protocol_bump_2: protocolBump,
  },
  // Seats first (the chart is derived from their frontmatter), then the
  // manifest, then routing, then the files, then the surface, and the version
  // last: `protocol_bump_2` reads the state every handler before it left.
  fixOrder: [
    ...fixers.FIX_ORDER.filter((k) => k !== "protocol_bump_2" && k !== "routing_scaffold"),
    "surface_regen",
    "protocol_bump_2",
  ],
};
