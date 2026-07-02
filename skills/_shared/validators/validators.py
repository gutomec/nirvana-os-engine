"""
Nirvana Protocol Validators (Python / Pydantic v2)

Mirror exato de validators.ts. Fail-closed validators para:
- Squad Protocol v5
- Business Protocol v1
- Harness Protocol v1

Source schemas:
- ~/.claude/skills/_shared/schemas/capability.schema.json
- ~/.claude/skills/_shared/schemas/business.schema.json
- ~/.claude/skills/_shared/schemas/core-schemas.json

Dependencies:
- pydantic>=2.0
- pytest>=7 (apenas para rodar os testes embutidos)

Self-test (smoke):
    python validators.py test

Pytest:
    pytest validators.py -v
"""

from __future__ import annotations

import re
import sys
import uuid
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

# Limites configuráveis (cascata user -> project -> env). Sem .yaml/env,
# LIMITS == DEFAULTS == valores historicos (backward-compatible).
# Ver limits.py e _shared/CONFIGURATION.md secao "Limites configuraveis".
#
# Import robusto do modulo irmao `limits`: garante o diretorio deste
# arquivo em sys.path ANTES do import. Necessario porque validators.py e
# carregado de 3 formas — `import validators`, `python validators.py`, e
# importlib.spec_from_file_location (capability-validator.js do skill
# squads) — e a 3a forma nao poe o diretorio em sys.path.
import os as _os
import sys as _sys

_VALIDATORS_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _VALIDATORS_DIR not in _sys.path:
    _sys.path.insert(0, _VALIDATORS_DIR)

try:
    from limits import LIMITS  # type: ignore[import-not-found]
except Exception as _limits_exc:  # noqa: BLE001 — fail-safe: limits nunca derruba validacao
    # Fallback ultra-defensivo: se limits.py estiver ausente/corrompido,
    # usa os DEFAULTS historicos hard-coded. Sistema continua funcionando.
    _sys.stderr.write(f"[nirvana-limits] WARN: fallback p/ defaults ({_limits_exc})\n")
    LIMITS = {
        "business_description_max": 500, "business_produces_max": 30,
        "business_example_briefs_max": 15, "business_example_briefs_item_max": 500,
        "business_keywords_max": 40, "business_capabilities_max": 100,
        "employee_description_max": None, "employee_max_turns_max": 200,
        "capability_description_max": 500, "capability_produces_max": 20,
        "capability_example_briefs_max": 10, "capability_example_briefs_item_max": 500,
        "capability_keywords_max": 30, "squad_capabilities_max": 50,
        "dna_max_turns_max": 200, "handoff_summary_max": 1000,
        "handoff_files_modified_max": 10, "business_memory_max_facts_ceiling": 5000,
        "harness_default_max_tokens": 200_000, "harness_default_max_cost_usd": 2.00,
        "harness_default_max_handoffs": 20, "harness_default_max_duration_seconds": 600,
    }


# ──────────────────────────────────────────────────────────────────────
# Primitives — regex strings (idênticos a validators.ts)
# ──────────────────────────────────────────────────────────────────────

KEBAB_CASE = r"^[a-z][a-z0-9-]{1,63}$"
SNAKE_CASE = r"^[a-z][a-z0-9_]*$"
CAPABILITY_ID = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$"
SEMVER = r"^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$"
TICKET_ID = r"^TKT-\d{4}-\d{2}-\d{2}-\d+$"
SHA256 = r"^sha256:[a-f0-9]{64}$"
ENV_VAR = r"^[A-Z][A-Z0-9_]*$"
MENTION = r"^@[a-z][a-z0-9-]+$"

# Aliases de tipo reutilizáveis
KebabCaseStr = Annotated[str, StringConstraints(pattern=KEBAB_CASE)]
SnakeCaseStr = Annotated[str, StringConstraints(pattern=SNAKE_CASE)]
CapabilityIdStr = Annotated[str, StringConstraints(pattern=CAPABILITY_ID)]
SemverStr = Annotated[str, StringConstraints(pattern=SEMVER)]
TicketIdStr = Annotated[str, StringConstraints(pattern=TICKET_ID)]
EnvVarStr = Annotated[str, StringConstraints(pattern=ENV_VAR)]
MentionStr = Annotated[str, StringConstraints(pattern=MENTION)]
KebabHyphenStr = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]+$")]
SnakeUnderscoreId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]+$")]
# Fix (2026-05): regex anterior `^[a-z_]+$` bloqueava digitos nao-iniciais
# (ex.: `iso_42001_compliant`, `gpt4_check`). Agora aceita digitos apos o
# 1o caractere, mantendo snake_case. Comeca com letra; sem digito inicial.
SelfScoreCriterionId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]*$")]


class Runtime(str, Enum):
    claude_code = "claude-code"
    codex = "codex"
    gemini_cli = "gemini-cli"
    cursor = "cursor"
    antigravity = "antigravity"
    antigravity_cli = "antigravity-cli"  # canonical name used across squads/businesses (gemini-cli successor)
    openclaw = "openclaw"
    opencode = "opencode"


class Model(str, Enum):
    haiku = "haiku"
    sonnet = "sonnet"
    opus = "opus"
    inherit = "inherit"


class Severity(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class FidelityStatus(str, Enum):
    validated = "validated"
    experimental = "experimental"
    drifted = "drifted"
    retired = "retired"


# Base estrita: rejeita campos extras (mirror de additionalProperties: false do JSON Schema)
class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ──────────────────────────────────────────────────────────────────────
# Squad Protocol v5
# ──────────────────────────────────────────────────────────────────────


class CapabilityInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: SnakeCaseStr
    type: Literal["file", "string", "json", "array", "number", "boolean", "url"]
    formats: Optional[list[str]] = None
    schema_: Optional[str] = Field(default=None, alias="schema")
    required: bool = True
    description: Optional[str] = None


class CapabilityOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: SnakeCaseStr
    type: Literal["file", "string", "json", "array", "markdown", "html", "binary"]
    format: Optional[str] = None
    schema_: Optional[str] = Field(default=None, alias="schema")
    description: Optional[str] = None


class CapabilityInvoke(StrictModel):
    type: Literal["workflow", "task", "agent"]
    ref: str
    agent: Optional[str] = None
    prompt_template: Optional[str] = None
    inputs_mapping: Optional[dict[str, Any]] = None


class CapabilityFidelity(StrictModel):
    ground_truth_dir: Optional[str] = None
    eval_results: Optional[str] = None
    status: FidelityStatus = FidelityStatus.experimental
    last_eval: Optional[datetime] = None
    judge_model: Optional[str] = None
    threshold: float = Field(default=0.85, ge=0, le=1)


class Capability(StrictModel):
    id: CapabilityIdStr
    description: Annotated[str, StringConstraints(min_length=20, max_length=LIMITS["capability_description_max"])]
    domains: Annotated[list[SnakeCaseStr], Field(min_length=1, max_length=5)]
    inputs: Optional[list[CapabilityInput]] = None
    outputs: Optional[list[CapabilityOutput]] = None
    tools_required: Optional[list[str]] = None
    invoke: CapabilityInvoke
    examples: Annotated[
        list[Annotated[str, StringConstraints(min_length=5)]],
        Field(min_length=1),
    ]
    produces: Optional[Annotated[list[Annotated[str, StringConstraints(min_length=3, max_length=80)]], Field(min_length=1, max_length=LIMITS["capability_produces_max"])]] = None
    example_briefs: Optional[Annotated[list[Annotated[str, StringConstraints(min_length=20, max_length=LIMITS["capability_example_briefs_item_max"])]], Field(max_length=LIMITS["capability_example_briefs_max"])]] = None
    keywords: Optional[Annotated[list[Annotated[str, StringConstraints(min_length=2, max_length=60)]], Field(max_length=LIMITS["capability_keywords_max"])]] = None
    not_for: Optional[list[Annotated[str, StringConstraints(min_length=5)]]] = None
    fidelity: Optional[CapabilityFidelity] = None
    score_boost: float = Field(default=1.0, ge=0, le=2)
    model_hint: Model = Model.sonnet
    estimated_cost_usd: Optional[float] = Field(default=None, ge=0)
    parallel_safe: bool = False
    writes_paths: Optional[list[str]] = None


class RuntimeRequirementMin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtime: Runtime
    version: Optional[str] = None


class RuntimeRequirements(StrictModel):
    minimum: Annotated[list[RuntimeRequirementMin], Field(min_length=1)]
    compatible: Optional[list[Any]] = None
    incompatible: Optional[list[Any]] = None


class SquadComponents(StrictModel):
    agents: Optional[list[str]] = None
    tasks: Optional[list[str]] = None
    workflows: Optional[list[str]] = None
    schemas: Optional[list[str]] = None  # JSON Schemas the squad ships for output validation


class SquadOutput(StrictModel):
    base_dir: str = "default"


class SquadLegacy(StrictModel):
    v4_path: Optional[str] = None


class SquadManifest(StrictModel):
    # Philosophy (b): squads may carry user/system-specific extra top-level
    # metadata (e.g. external_requirements, smoke_test). Tolerate unknown keys
    # instead of failing, so the protocol doesn't need a bump per new field —
    # extras live as extras until common enough to formalize. The capability
    # validator emits a WARN per unknown top-level key for visibility (so we can
    # see what to standardize). Known fields below are still type-checked.
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    name: KebabCaseStr
    version: SemverStr
    protocol: Literal["4.0", "4.1", "5.0"]
    description: Optional[Annotated[str, StringConstraints(min_length=20)]] = None
    author: Optional[str] = None
    license: str = "MIT"
    slashPrefix: Optional[str] = None
    tags: Optional[list[str]] = None
    capabilities: Optional[Annotated[list[Capability], Field(max_length=LIMITS["squad_capabilities_max"])]] = None
    experimental_domains: bool = False
    components: SquadComponents
    runtime_requirements: Optional[RuntimeRequirements] = None
    features_required: Optional[list[str]] = None
    features_optional: Optional[list[str]] = None
    output: Optional[SquadOutput] = None
    legacy: Optional[SquadLegacy] = None
    # Optional squad-level metadata blocks (declarative; carried through validation).
    io: Optional[dict] = None          # input/output contract beyond per-capability inputs/outputs
    memory: Optional[dict] = None      # squad-scoped memory config (e.g. persistent + garbage_collection)
    instrumentation: Optional[dict] = None  # §26 telemetry opt-in


# ──────────────────────────────────────────────────────────────────────
# Business Protocol v1
# ──────────────────────────────────────────────────────────────────────


class SelfScoreCriterion(StrictModel):
    id: SelfScoreCriterionId
    description: str
    threshold: float = Field(..., ge=0, le=1)
    weight: float = Field(default=1.0, ge=0)


class SelfScoreContract(StrictModel):
    required_before_handoff: bool = True
    criteria: Annotated[list[SelfScoreCriterion], Field(min_length=1)]
    on_below_threshold: Literal["revise", "escalate", "annotate"] = "revise"
    max_revise_iterations: int = Field(default=2, ge=0, le=5)


class EscalationTrigger(StrictModel):
    id: SnakeUnderscoreId
    # condition + severity are recommended but optional: some triggers are
    # action-only (e.g. an AskUserQuestion gate) and don't carry a threshold
    # condition or a severity band.
    condition: Optional[str] = None
    threshold: Optional[Union[float, str]] = None
    currency: Optional[Literal["USD", "BRL", "EUR"]] = None
    severity: Optional[Severity] = None
    notify: str
    action: Optional[str] = None
    options: Optional[list[str]] = None
    rationale: Optional[str] = None
    timeout_minutes: Optional[int] = Field(default=None, ge=1)
    escalate_to: Optional[str] = None
    detect: Optional[str] = None


class EmployeeHeartbeat(StrictModel):
    cadence: Literal["hourly", "daily", "weekly", "manual", "on-demand"] = "manual"
    max_cost_per_cycle_usd: Optional[float] = Field(default=None, ge=0)
    enabled: bool = False
    on_unproductive_cycle: Optional[Literal["continue", "pause_after_n"]] = None
    pause_after_n_unproductive: Optional[int] = Field(default=None, ge=1)


class EmployeeDrawsFrom(StrictModel):
    source: str
    weight: Optional[float] = Field(default=None, ge=0, le=1)
    use_for: Optional[list[str]] = None


class EmployeeMemory(StrictModel):
    permanent_path: Optional[str] = None


class EmployeeMentions(StrictModel):
    receives: Optional[list[MentionStr]] = None
    notification_priority: Literal["high", "normal", "low"] = "normal"


class EmployeeFrontmatter(StrictModel):
    name: KebabCaseStr
    role: Annotated[str, StringConstraints(min_length=2)]
    type: Literal["functional_specialist", "mind_clone", "orchestrator", "antagonist_gate"] = "functional_specialist"
    # max_length=None (default historico) => sem teto. Configuravel via
    # employee_description_max no nirvana-limits.yaml.
    description: Annotated[str, StringConstraints(min_length=20, max_length=LIMITS["employee_description_max"])]
    # maxTurns + self_score_contract: default-friendly so older businesses
    # (galinha-squads gen) load without a forced rewrite. New employees should
    # still declare both explicitly; the defaults are a safe floor, not a license
    # to skip accountability.
    maxTurns: int = Field(default=400, ge=1, le=LIMITS["employee_max_turns_max"])
    reports_to: Optional[KebabHyphenStr] = None
    manages: Optional[list[KebabHyphenStr]] = None
    tools: Optional[list[str]] = None
    # model accepts the short enum (sonnet) AND full vendor names
    # (claude-sonnet-4-6) used by earlier generators.
    model: Optional[str] = None
    budget_monthly_usd: Optional[float] = Field(default=None, ge=0)
    heartbeat: Optional[EmployeeHeartbeat] = None
    is_antagonist: bool = False
    is_brief_intake: bool = False
    antagonizes: Optional[list[str]] = None
    squads_authorized: Optional[list[KebabCaseStr]] = None
    draws_from: Optional[list[EmployeeDrawsFrom]] = None
    dna_reference: Optional[str] = None
    disclosure_required: Optional[bool] = None
    commercial_use_allowed: Optional[Literal["never", "review", "allowed"]] = None
    self_score_contract: Optional[SelfScoreContract] = None
    memory: Optional[EmployeeMemory] = None
    mentions: Optional[EmployeeMentions] = None
    escalation_triggers: Optional[list[EscalationTrigger]] = None
    # ── Fields from earlier business generations (galinha-squads), officialized
    # 2026-05-21 so rich legacy employees validate without rewrite ──
    effort: Optional[Literal["low", "medium", "high"]] = None
    authority_level: Optional[Literal["tier-1", "tier-2", "tier-3"]] = None
    assigned_mind_clones: Optional[list[str]] = None
    mind_clones_used: Optional[list[str]] = None
    squad_dispatched: Optional[list[str]] = None
    operation_mode: Optional[Literal["zero_human", "hybrid", "human_in_loop"]] = None
    secondary_role: Optional[str] = None

    @model_validator(mode="after")
    def _mind_clone_requires_disclosure(self) -> "EmployeeFrontmatter":
        # BP refinement: mind_clone employees MUST have disclosure_required=true
        if self.type == "mind_clone" and not self.disclosure_required:
            raise ValueError("mind_clone employees require disclosure_required: true")
        return self


# ── Business Manifest ────────────────────────────────────────────────


class BusinessOutput(StrictModel):
    base_dir: str = "default"


class BusinessMemoryGC(StrictModel):
    max_facts: int = Field(default=500, ge=50, le=LIMITS["business_memory_max_facts_ceiling"])
    review_interval_days: int = Field(default=60, ge=1, le=365)
    conflict_resolution: Literal["replace", "append", "prompt"] = "replace"


class BusinessMemoryPermanent(StrictModel):
    enabled: bool = True
    files: Optional[list[str]] = None
    garbage_collection: Optional[BusinessMemoryGC] = None


class BusinessMemoryProject(StrictModel):
    isolation: Literal["by_construction", "advisory"] = "by_construction"
    layout: Optional[dict[str, Any]] = None


class BusinessMemory(StrictModel):
    permanent: Optional[BusinessMemoryPermanent] = None
    project: Optional[BusinessMemoryProject] = None


class BusinessLegacy(BaseModel):
    """Free-form bag for paperclip migration metadata.

    Open by design (extra='allow') so the migration adapter can preserve any
    non-mappable artifact under namespaced keys (e.g. paperclip_role,
    paperclip_metadata, paperclip_runtime_config). Mirror of business.schema.json
    legacy `additionalProperties: true`.
    """

    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    paperclip_company_id: Optional[str] = None
    paperclip_instance: Optional[str] = None
    paperclip_data_dir: Optional[str] = None
    migration_date: Optional[datetime] = None
    migration_audit_log: Optional[str] = None

    @field_validator("paperclip_company_id")
    @classmethod
    def _validate_uuid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            uuid.UUID(v)
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValueError(f"paperclip_company_id must be a valid UUID, got: {v!r}") from exc
        return v


class BusinessUI(StrictModel):
    icon: Optional[str] = None
    category: Optional[str] = None
    client_facing_name: Optional[str] = None
    pitch: Optional[str] = None
    employees_metadata: Optional[dict[str, Any]] = None


# Whitelist de features (refletido de business.schema.json — mais rígido que zod)
FEATURES_VALID: set[str] = {
    # Runtime / control
    "max_turns", "tool_whitelist", "subagent_spawning", "subagents",
    "sequential_execution", "audit_trail", "scheduled_invocation", "event_bus",
    "hooks", "sandboxing", "thinking_blocks", "plugin_sdk",
    # Memory
    "session_memory", "project_memory", "global_memory",
    # Handoffs / context
    "handoff_artifacts", "fork_context", "teammate_primitive",
    # Observability
    "telemetry_otel", "feedback_tracking", "document_revisions", "execution_workspaces", "git_isolation",
    # Tool primitives (semantic; runtime-agnostic)
    "file_read", "file_write", "shell_exec", "bash_execution",
    "tools.read", "tools.write", "tools.exec",
    # Agent capabilities
    "web_search", "web_fetch", "vision_input",
    # Misc
    "native_company_import_export",
}


class BusinessAutoRoute(BaseModel):
    """A business-level routing rule: a regex pattern that, when it matches a
    brief, sends the work to a specific employee (or route_to target). Read by
    the router (router.js _business_routing) and the registry indexer."""
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)
    pattern: str
    employee: Optional[str] = None
    route_to: Optional[str] = None


class BusinessManifest(StrictModel):
    name: KebabCaseStr
    version: SemverStr
    protocol: Literal["1.0"]
    description: Annotated[str, StringConstraints(min_length=20, max_length=LIMITS["business_description_max"])]
    author: Optional[str] = None
    owner: Optional[str] = None
    license: str = "MIT"
    domains: Annotated[list[SnakeCaseStr], Field(min_length=1, max_length=50)]
    employee_count: Optional[int] = Field(default=None, ge=1, le=100)
    authority_level: Literal["tier-1", "tier-2", "tier-3"] = "tier-2"
    capabilities: Optional[Annotated[list[CapabilityIdStr], Field(max_length=LIMITS["business_capabilities_max"])]] = None
    produces: Optional[Annotated[list[Annotated[str, StringConstraints(min_length=3, max_length=80)]], Field(min_length=1, max_length=LIMITS["business_produces_max"])]] = None
    example_briefs: Optional[Annotated[list[Annotated[str, StringConstraints(min_length=20, max_length=LIMITS["business_example_briefs_item_max"])]], Field(max_length=LIMITS["business_example_briefs_max"])]] = None
    keywords: Optional[Annotated[list[Annotated[str, StringConstraints(min_length=2, max_length=60)]], Field(max_length=LIMITS["business_keywords_max"])]] = None
    squads_authorized: Optional[list[KebabCaseStr]] = None
    operation_mode: Literal["zero_human", "hybrid", "human_in_loop"] = "zero_human"
    output: Optional[BusinessOutput] = None
    memory: Optional[BusinessMemory] = None
    runtime_requirements: RuntimeRequirements
    features_required: Optional[list[str]] = None
    features_optional: Optional[list[str]] = None
    env_required: Optional[list[EnvVarStr]] = None
    legacy: Optional[BusinessLegacy] = None
    ui: Optional[BusinessUI] = None
    experimental_domains: bool = False
    # ── Advanced orchestration fields (officialized 2026-05-21) ──
    # auto_routes + quality_gate are read by the runtime (router.js, proposal-
    # writer, glance). The *_dependencies / shared_memory / defaults /
    # deliverable_bundle are declarative today (consumed opportunistically);
    # typed permissively so businesses can evolve them without schema churn.
    auto_routes: Optional[list[BusinessAutoRoute]] = None
    quality_gate: Optional[dict] = None
    squad_dependencies: Optional[dict] = None
    mind_clone_dependencies: Optional[dict] = None
    shared_memory: Optional[dict] = None
    defaults: Optional[dict] = None
    deliverable_bundle: Optional[list[str]] = None

    @field_validator("features_required")
    @classmethod
    def _validate_features_required(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is None:
            return v
        for f in v:
            if f not in FEATURES_VALID:
                raise ValueError(f"features_required contains unknown feature: {f!r}")
        return v


# ── OrgChart ─────────────────────────────────────────────────────────


class OrgChartNode(StrictModel):
    employee: KebabCaseStr
    reports: Annotated[list[str], Field(max_length=1)]
    direct_reports: list[str]
    is_antagonist: bool = False
    antagonizes: Optional[list[str]] = None


class OrgChartAntagonistRules(StrictModel):
    triggers: Optional[list[str]] = None


class OrgChartRoutingRules(StrictModel):
    escalation_path: Optional[dict[str, str]] = None
    default_skip_levels: bool = False
    cross_team_handoff_allowed: bool = True
    antagonist_invocation: Optional[OrgChartAntagonistRules] = None
    # Approval gates: human/employee sign-off required before a sensitive
    # action (e.g. kdp_publish, rebrand). Each item: {gate, blocked_by, rationale}.
    approval_gates: Optional[list[dict]] = None


class OrgChart(BaseModel):
    # Two accepted layouts: the canonical `chart` (list of OrgChartNode) and the
    # legacy `org` (dict keyed by employee with role/reports_to/manages). Both
    # validate; top-level metadata (name/version/generated_at) is tolerated.
    # extra="allow" so older org-charts don't break on minor extra keys.
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)
    chart: Optional[Annotated[list[OrgChartNode], Field(min_length=1)]] = None
    org: Optional[dict] = None
    routing_rules: Optional[OrgChartRoutingRules] = None
    name: Optional[str] = None
    version: Optional[str] = None
    generated_at: Optional[str] = None

    @model_validator(mode="after")
    def _require_chart_or_org(self):
        if self.chart is None and self.org is None:
            raise ValueError("org-chart must define either `chart` (list) or `org` (dict)")
        return self

    @model_validator(mode="after")
    def _exactly_one_ceo(self) -> "OrgChart":
        # Only enforce the single-root rule on the canonical `chart` layout.
        # The legacy `org` (dict) layout encodes the root as reports_to: null
        # and is validated structurally elsewhere; skip the chart-specific check.
        if self.chart is None:
            return self
        ceos = [e for e in self.chart if len(e.reports) == 0]
        if len(ceos) != 1:
            raise ValueError(
                f"Org chart must have exactly one employee with reports: [] (found {len(ceos)})"
            )
        return self


# ──────────────────────────────────────────────────────────────────────
# Handoff Artifact (Squad v4 §9 + Business v1 §10.6)
# ──────────────────────────────────────────────────────────────────────


class SelfScore(BaseModel):
    """Self-score artefato. Chaves arbitrárias (snake_case lowercase) mapeiam
    para floats em [0,1]. Campos nomeados cobrem metadata.

    Mirror do `SelfScoreSchema = z.record(...).and(z.object(...))` do TS.
    """

    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    passes_threshold: Optional[bool] = None
    iteration: Optional[int] = Field(default=None, ge=0)
    justifications: Optional[dict[str, str]] = None

    @model_validator(mode="after")
    def _validate_score_keys(self) -> "SelfScore":
        for k, v in (self.model_extra or {}).items():
            if not re.fullmatch(r"^[a-z_]+$", k):
                raise ValueError(
                    f"SelfScore criterion key must match ^[a-z_]+$, got: {k!r}"
                )
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ValueError(
                    f"SelfScore value for {k!r} must be a number in [0,1], got {type(v).__name__}"
                )
            if not (0 <= float(v) <= 1):
                raise ValueError(f"SelfScore value for {k!r} must be in [0,1], got {v!r}")
        return self


class HandoffBusinessExtensions(StrictModel):
    type: Literal["mention", "ticket", "escalation", "delegation", "auto_route"]
    mention_text: Optional[str] = None
    ticket_id: Optional[str] = None
    project_id: Optional[str] = None
    business_slug: Optional[str] = None
    self_score: Optional[SelfScore] = None
    expected_response: Optional[str] = None
    deadline: Optional[datetime] = None
    audit_trail_id: Optional[str] = None
    humanized: Optional[bool] = None


class ConsumedInput(StrictModel):
    from_task_id: str
    output_id: str


class HandoffArtifact(StrictModel):
    schemaVersion: str = "1.0.0"
    from_agent: str
    to_agent: str
    summary: Annotated[str, StringConstraints(min_length=10, max_length=LIMITS["handoff_summary_max"])]
    # key_decisions e blockers permanecem hard-coded (feature de design:
    # forcam priorizacao — ver CONFIGURATION.md). files_modified e configuravel.
    key_decisions: Optional[Annotated[list[str], Field(max_length=5)]] = None
    files_modified: Optional[Annotated[list[str], Field(max_length=LIMITS["handoff_files_modified_max"])]] = None
    blockers: Optional[Annotated[list[str], Field(max_length=3)]] = None
    next_action: str
    artifacts: Optional[list[str]] = None
    business_extensions: Optional[HandoffBusinessExtensions] = None
    # DAG dataflow tracing (optional, backward-compatible)
    produced_by_task_id: Optional[str] = None
    consumed_inputs: Optional[list[ConsumedInput]] = None


class TicketExpectedOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    type: Literal["approval", "revisions", "rejection", "deliverable", "decision"]
    schema_: Optional[str] = Field(default=None, alias="schema")


class TicketHistoryEntry(StrictModel):
    event: str
    by: str
    at: datetime


class Ticket(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    ticket_id: TicketIdStr
    schemaVersion: str = "1.0.0"
    type: Literal["request", "review", "approval", "bug", "escalation"]
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    from_: str = Field(..., alias="from")
    to: str
    project_id: str
    business: str
    subject: Annotated[str, StringConstraints(min_length=5)]
    body: str
    expected_output: Optional[TicketExpectedOutput] = None
    due_date: Optional[datetime] = None
    self_score: Optional[SelfScore] = None
    linked_handoff: Optional[str] = None
    status: Literal["open", "in_progress", "resolved", "rejected", "paused", "cancelled"]
    created_at: datetime
    resolved_at: Optional[datetime] = None
    history: Optional[list[TicketHistoryEntry]] = None


# ──────────────────────────────────────────────────────────────────────
# Harness Protocol v1
# ──────────────────────────────────────────────────────────────────────


class HarnessRouting(StrictModel):
    match_high_threshold: float = 0.80
    match_high_lead: float = 0.15
    match_ambiguous_threshold: float = 0.60
    match_ambiguous_window: float = 0.15
    tier2_embedding: Literal["disabled", "enabled"] = "disabled"
    tier2_provider: Optional[str] = None
    tier2_threshold: Optional[float] = None
    auto_invoke_validated_capabilities: bool = True
    auto_invoke_budget_usd: float = 1.00


class HarnessBudget(StrictModel):
    # Defaults configuraveis via nirvana-limits.yaml. EXECUTION CONTROL:
    # aumentar exige cap orcamentario explicito no projeto (risco financeiro).
    default_max_cost_usd: float = LIMITS["harness_default_max_cost_usd"]
    default_max_tokens: int = LIMITS["harness_default_max_tokens"]
    default_max_handoffs: int = LIMITS["harness_default_max_handoffs"]
    default_max_duration_seconds: int = LIMITS["harness_default_max_duration_seconds"]
    on_budget_exceeded: Literal["abort", "warn", "escalate"] = "abort"


class HarnessTelemetry(StrictModel):
    provider: Literal["otel", "jsonl", "none"] = "otel"
    otlp_endpoint: Optional[str] = None
    fallback_jsonl_path: str = "~/.harness-logs/"
    service_name: str = "harness"


class HarnessMemoryConfig(StrictModel):
    isolation_enforcement: Literal["strict", "advisory"] = "strict"


class HarnessAuditConfig(StrictModel):
    enabled: bool = True
    project_retention_days: int = 365
    session_retention_days: int = 90
    on_expiry: Literal["archive", "delete", "rotate"] = "archive"


class HarnessSkillsConfig(StrictModel):
    squads_dir: str = "~/squads-v5"
    squads_legacy_dir: str = "~/squads"
    businesses_dir: str = "~/businesses"


class HarnessConfig(StrictModel):
    version: Literal["1.0"]
    routing: Optional[HarnessRouting] = None
    budget: Optional[HarnessBudget] = None
    telemetry: Optional[HarnessTelemetry] = None
    memory: Optional[HarnessMemoryConfig] = None
    audit: Optional[HarnessAuditConfig] = None
    skills: Optional[HarnessSkillsConfig] = None


AuditEventType = Literal[
    "brief_received", "routing_decision", "invocation_start", "invocation_end",
    "cost_emission", "handoff", "ticket_opened", "ticket_resolved",
    "escalation_trigger_fired", "human_notification_required", "human_response_received",
    "resume", "approval_checkpoint", "approval_granted", "approval_rejected",
    "budget_violation", "memory_write", "isolation_violation", "validation_failed",
]


class AuditEvent(BaseModel):
    """Audit event. Permite campos extras por tipo (passthrough no zod)."""

    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    ts: datetime
    event: AuditEventType
    trace_id: Optional[str] = None
    project_id: Optional[str] = None
    business_slug: Optional[str] = None
    squad_name: Optional[str] = None
    agent_or_employee: Optional[str] = None


class HarnessNotificationContext(StrictModel):
    summary: str
    current_invocation: Optional[str] = None
    audit_log_excerpt: Optional[str] = None


class HarnessNotificationOption(StrictModel):
    id: str
    description: str


class HarnessNotification(StrictModel):
    schema_version: str = "1.0.0"
    type: Literal["human_escalation_required"]
    trigger_id: str
    severity: Severity
    project_id: str
    business_slug: Optional[str] = None
    context: HarnessNotificationContext
    options: Annotated[list[HarnessNotificationOption], Field(min_length=1)]
    timeout_minutes: Optional[int] = Field(default=None, ge=1)
    default_on_timeout: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────
# DNA Mind-Clone (Onda 2.1 — canonical v2026 format)
# ──────────────────────────────────────────────────────────────────────


# Canonical structure: 10 numbered top-level sections (## 1. through ## 10.).
# Title text is free-form because the canonical evolved: original TEMPLATE.md (2026)
# used FILOSOFIA/MODELOS-MENTAIS/etc., while later batches (categories 56-61) adopted
# IDENTIDADE-E-CONTEXTO/FILOSOFIA-CENTRAL/etc. Validator checks section count + ordering,
# not specific titles. The strict v2026 titles live in the TEMPLATE.md reference,
# enforced by editorial review when generating new mindclones from scratch.
DNA_REQUIRED_SECTIONS = [
    rf"^## {n}\.\s"
    for n in range(1, 11)
]

CategoryStr = Annotated[str, StringConstraints(pattern=r"^[0-9]{2}-[a-z][a-z0-9-]+$")]


class DNAFrontmatter(BaseModel):
    """Frontmatter of a canonical mind-clone file. Validates without parsing the body.

    Open by design (extra='allow') because the canonical batch evolves: new fields like
    `cargo` and `batch` were added in the 2026 wave (categories 34-61) for org-chart
    pinning. Required core fields are name, description, model, maxTurns, tools.
    """

    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    name: KebabCaseStr
    description: Annotated[str, StringConstraints(min_length=40)]
    model: Model = Model.sonnet
    maxTurns: int = Field(default=40, ge=1, le=LIMITS["dna_max_turns_max"])
    tools: Annotated[list[str], Field(min_length=1)]
    category: Optional[CategoryStr] = None
    fidelity: Optional[Literal["high", "medium", "low"]] = None
    updated: Optional[str] = None
    cargo: Optional[str] = None
    batch: Optional[int] = Field(default=None, ge=1)


class DNAValidationResult(BaseModel):
    valid: bool
    file_path: str
    frontmatter: Optional[DNAFrontmatter] = None
    missing_sections: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


def validate_dna_file(file_path: str) -> DNAValidationResult:
    """Validate a single mind-clone file against the canonical v2026 format.

    Checks:
    - File exists and is readable
    - Frontmatter parses and matches DNAFrontmatter schema
    - Body contains all 10 required canonical sections (in order)
    """
    import os
    import re

    if not os.path.isfile(file_path):
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=[f"File not found: {file_path}"],
        )

    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=[f"Could not read file: {exc}"],
        )

    # Parse frontmatter (between --- delimiters)
    fm_match = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, flags=re.DOTALL)
    if not fm_match:
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=["Missing or malformed frontmatter (expected --- ... ---)"],
        )

    fm_yaml, body = fm_match.group(1), fm_match.group(2)

    try:
        import yaml as _yaml
    except ImportError:
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=["pyyaml not installed; cannot parse frontmatter"],
        )

    try:
        fm_data = _yaml.safe_load(fm_yaml)
    except _yaml.YAMLError as exc:
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=[f"Frontmatter YAML parse error: {exc}"],
        )

    if not isinstance(fm_data, dict):
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=["Frontmatter must be a mapping"],
        )

    errors: list[str] = []
    missing: list[str] = []

    try:
        fm = DNAFrontmatter.model_validate(fm_data)
    except Exception as exc:
        return DNAValidationResult(
            valid=False,
            file_path=file_path,
            errors=[f"Frontmatter schema violation: {exc}"],
        )

    # Body section checks
    for pattern in DNA_REQUIRED_SECTIONS:
        if not re.search(pattern, body, flags=re.MULTILINE):
            missing.append(pattern)

    if missing:
        errors.append(f"Missing canonical sections: {len(missing)} of 10")

    return DNAValidationResult(
        valid=not errors,
        file_path=file_path,
        frontmatter=fm,
        missing_sections=missing,
        errors=errors,
    )


# ──────────────────────────────────────────────────────────────────────
# Routing (Business Protocol v1 §13)
# ──────────────────────────────────────────────────────────────────────


class RoutingBriefIntakeAlternate(StrictModel):
    condition: str
    route_to: str
    bypass_auto_routes: bool = False


class RoutingBriefIntake(BaseModel):
    """brief_intake. additionalProperties not declared explicitly in JSON,
    so we keep BaseModel + extra='ignore' to avoid silent strict mismatch."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    default_employee: str
    alternates: Optional[list[RoutingBriefIntakeAlternate]] = None


class RoutingAutoRoute(StrictModel):
    pattern: str
    route_to: str
    confidence_threshold: float = 0.7
    requires_escalation_to: Optional[str] = None


class RoutingMentionRoute(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    mention: MentionStr
    route_to: str


class RoutingTicketIntake(StrictModel):
    default_assignee: Optional[str] = None
    by_type: Optional[dict[str, str]] = None  # keys validados via field_validator

    @field_validator("by_type")
    @classmethod
    def _validate_by_type_keys(cls, v: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
        if v is None:
            return v
        for key in v:
            if not re.fullmatch(r"^[a-z_]+$", key):
                raise ValueError(f"ticket_intake.by_type key must match ^[a-z_]+$, got: {key!r}")
        return v


class Routing(StrictModel):
    brief_intake: Optional[RoutingBriefIntake] = None
    auto_routes: Optional[list[RoutingAutoRoute]] = None
    mention_routing: Optional[list[RoutingMentionRoute]] = None
    ticket_intake: Optional[RoutingTicketIntake] = None


# ──────────────────────────────────────────────────────────────────────
# Mention (Business Protocol v1 §10.1)
# ──────────────────────────────────────────────────────────────────────


class Mention(StrictModel):
    schemaVersion: str = "1.0.0"
    type: Literal["mention"]
    from_: str = Field(..., alias="from")
    to: str
    mention_text: str
    context_path: Optional[str] = None
    self_score: Optional[SelfScore] = None
    expected_response: Optional[str] = None
    deadline: Optional[datetime] = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)


# ──────────────────────────────────────────────────────────────────────
# Approval Chain (Business Protocol v1 §14.3)
# ──────────────────────────────────────────────────────────────────────


class ApprovalChainStep(StrictModel):
    producer: Optional[str] = None
    reviewer: Optional[str] = None
    approver: Optional[str] = None
    final_approver: Optional[str] = None
    human_checkpoint: Optional[Literal["required", "optional", "skip"]] = None


class ApprovalChain(StrictModel):
    chain: Annotated[list[ApprovalChainStep], Field(min_length=1)]
    on_approval: Optional[
        Literal["deliver_to_client", "merge_to_final", "publish", "notify"]
    ] = None
    on_rejection_at_review: Optional[
        Literal["send_back_to_producer", "escalate", "abort"]
    ] = None
    on_rejection_at_approval: Optional[
        Literal["send_back_to_producer", "escalate_to_human", "abort"]
    ] = None


# ──────────────────────────────────────────────────────────────────────
# Registries (Squad v5 §23, Business v1 §App-?)
# ──────────────────────────────────────────────────────────────────────


SHA256_PATTERN = r"^sha256:[a-f0-9]{64}$"


class RegistrySquadEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    version: str
    protocol: str
    manifest_path: str
    manifest_hash: Annotated[str, StringConstraints(pattern=SHA256_PATTERN)]
    domains: list[str]
    capabilities: Optional[list[str]] = None


class RegistryCapabilityProvider(BaseModel):
    """An entry in registry.capabilities[<capability_id>][]."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    squad: str
    description: str
    domains: list[str]
    examples: Optional[list[str]] = None
    not_for: Optional[list[str]] = None
    fidelity_status: Optional[FidelityStatus] = None
    invoke: Optional[dict[str, Any]] = None
    score_boost: float = 1.0


class RegistrySquads(StrictModel):
    schema_version: str = "1.0.0"
    generated_at: datetime
    host_protocol_version: Literal["5.0", "4.0"]
    squads_root_dirs: list[str]
    squads: dict[str, RegistrySquadEntry]
    capabilities: dict[str, list[RegistryCapabilityProvider]]
    domains: Optional[dict[str, list[str]]] = None
    bm25_index: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def _validate_keys(self) -> "RegistrySquads":
        # squads keys must match KEBAB_CASE-ish (^[a-z][a-z0-9-]+$)
        for key in self.squads:
            if not re.fullmatch(r"^[a-z][a-z0-9-]+$", key):
                raise ValueError(f"RegistrySquads.squads key must match ^[a-z][a-z0-9-]+$, got: {key!r}")
        for cap_id in self.capabilities:
            if not re.fullmatch(CAPABILITY_ID, cap_id):
                raise ValueError(f"RegistrySquads.capabilities key must be a capability id, got: {cap_id!r}")
        if self.domains is not None:
            for d in self.domains:
                if not re.fullmatch(SNAKE_CASE, d):
                    raise ValueError(f"RegistrySquads.domains key must match {SNAKE_CASE}, got: {d!r}")
        return self


class RegistryBusinessEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    version: str
    protocol: Literal["1.0"]
    manifest_path: str
    manifest_hash: Annotated[str, StringConstraints(pattern=SHA256_PATTERN)]
    domains: list[str]
    capabilities: list[str]
    employee_count: Optional[int] = None
    operation_mode: Optional[Literal["zero_human", "hybrid", "human_in_loop"]] = None
    authority_level: Optional[Literal["tier-1", "tier-2", "tier-3"]] = None
    legacy_paperclip_id: Optional[str] = None
    # Optional discovery hints copied from MANIFEST.yaml — fed to harness Stage 2
    # BM25/keyword routing. The registry writer (lib/registry.py) populates these
    # whenever a business manifest declares them.
    produces: Optional[list[str]] = None
    example_briefs: Optional[list[str]] = None
    keywords: Optional[list[str]] = None

    @field_validator("legacy_paperclip_id")
    @classmethod
    def _validate_uuid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            uuid.UUID(v)
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValueError(f"legacy_paperclip_id must be a valid UUID, got: {v!r}") from exc
        return v


class RegistryBusinesses(StrictModel):
    schema_version: str = "1.0.0"
    generated_at: datetime
    businesses_root_dirs: Optional[list[str]] = None
    businesses: dict[str, RegistryBusinessEntry]

    @model_validator(mode="after")
    def _validate_keys(self) -> "RegistryBusinesses":
        for key in self.businesses:
            if not re.fullmatch(r"^[a-z][a-z0-9-]+$", key):
                raise ValueError(f"RegistryBusinesses.businesses key must match ^[a-z][a-z0-9-]+$, got: {key!r}")
        return self


# ──────────────────────────────────────────────────────────────────────
# Cross-protocol cross-checks (BP7, BP9, etc.)
# ──────────────────────────────────────────────────────────────────────


class BusinessLoadContext(BaseModel):
    """Artefatos carregados de um business para validação de integridade end-to-end."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    manifest: BusinessManifest
    employees: list[EmployeeFrontmatter]
    org_chart: OrgChart


class BusinessIntegrityResult(BaseModel):
    valid: bool
    errors: list[str]


def validate_business_integrity(ctx: BusinessLoadContext) -> BusinessIntegrityResult:
    """Mirror de validateBusinessIntegrity() de validators.ts.

    Verifica:
    - BP7: > 5 employees ⇒ ao menos 1 antagonista
    - exatamente 1 brief_intake
    - org chart referencia apenas employees declarados
    - reporting bidirecional consistente
    - sem ciclos no org chart
    - manifest.employee_count bate com employees[].length
    """
    errors: list[str] = []

    # BP7
    if len(ctx.employees) > 5:
        antagonists = [e for e in ctx.employees if e.is_antagonist]
        if not antagonists:
            errors.append(
                "BP7 violation: businesses with > 5 employees require at least 1 employee with is_antagonist: true"
            )

    # Exactly one brief_intake
    intakes = [e for e in ctx.employees if e.is_brief_intake]
    if len(intakes) != 1:
        errors.append(
            f"Exactly one employee must have is_brief_intake: true (found {len(intakes)})"
        )

    # Org chart consistency: every name in chart exists in employees[]
    # O formato alternativo `org:` (chart=None) não expõe nós chart; nesse caso
    # pulamos as checagens baseadas em chart (não há grafo para validar).
    employee_names = {e.name for e in ctx.employees}
    chart = ctx.org_chart.chart or []
    chart_by_name = {n.employee: n for n in chart}

    for node in chart:
        if node.employee not in employee_names:
            errors.append(f"Org chart references unknown employee: {node.employee}")
        for report_to in node.reports:
            if report_to not in employee_names:
                errors.append(f"Employee {node.employee} reports to unknown: {report_to}")
        for direct_report in node.direct_reports:
            if direct_report not in employee_names:
                errors.append(f"Employee {node.employee} manages unknown: {direct_report}")

    # Bidirectional reporting consistency
    for node in chart:
        for direct_report in node.direct_reports:
            child = chart_by_name.get(direct_report)
            if child is not None and node.employee not in child.reports:
                errors.append(
                    f"Bidirectional inconsistency: {node.employee} manages {direct_report} "
                    f"but {direct_report} doesn't report to {node.employee}"
                )

    # No cycles (DFS)
    visited: set[str] = set()
    recursing: set[str] = set()

    def detect_cycle(name: str) -> bool:
        if name in recursing:
            return True
        if name in visited:
            return False
        visited.add(name)
        recursing.add(name)
        node = chart_by_name.get(name)
        if node is not None:
            for child in node.direct_reports:
                if detect_cycle(child):
                    return True
        recursing.discard(name)
        return False

    for node in chart:
        if detect_cycle(node.employee):
            errors.append(f"Org chart cycle detected starting at {node.employee}")
            break

    # Manifest employee_count matches
    if (
        ctx.manifest.employee_count is not None
        and ctx.manifest.employee_count != len(ctx.employees)
    ):
        errors.append(
            f"Manifest employee_count ({ctx.manifest.employee_count}) "
            f"doesn't match actual count ({len(ctx.employees)})"
        )

    return BusinessIntegrityResult(valid=not errors, errors=errors)


# ──────────────────────────────────────────────────────────────────────
# Self-test (smoke) — equivale ao bloco final de validators.ts
# ──────────────────────────────────────────────────────────────────────


def _self_test() -> int:
    sample_capability = {
        "id": "media.video.analyze",
        "description": (
            "Analyze video file with multimodal LLM. Extracts transcript, "
            "on-screen text, key frames, hook analysis."
        ),
        "domains": ["media", "content"],
        "invoke": {"type": "task", "ref": "tasks/analyze.md"},
        "examples": ["transcrever vídeo do Instagram"],
    }
    try:
        cap = Capability.model_validate(sample_capability)
        print(f"Capability validation: OK (id={cap.id}, domains={cap.domains})")
        return 0
    except Exception as exc:
        print(f"Capability validation: FAIL\n{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "test":
        sys.exit(_self_test())


# ══════════════════════════════════════════════════════════════════════
# Pytest snippets — rodam com `pytest validators.py -v`
# ══════════════════════════════════════════════════════════════════════
# Os testes são auto-contidos: importam pytest dentro de cada teste
# para o módulo continuar utilizável fora de pytest sem dependência.


_VALID_CAPABILITY = {
    "id": "media.video.analyze",
    "description": "Analyze video file with multimodal LLM extracting transcripts and frames.",
    "domains": ["media"],
    "invoke": {"type": "task", "ref": "tasks/analyze.md"},
    "examples": ["transcrever vídeo do Instagram"],
}


def test_capability_minimal_valid() -> None:
    cap = Capability.model_validate(_VALID_CAPABILITY)
    assert cap.id == "media.video.analyze"
    assert cap.score_boost == 1.0
    assert cap.model_hint == Model.sonnet


def test_capability_id_must_be_dotted_min_3_segments() -> None:
    import pytest

    bad = {**_VALID_CAPABILITY, "id": "media.video"}  # 2 segments only
    with pytest.raises(Exception):
        Capability.model_validate(bad)


def test_capability_description_min_length() -> None:
    import pytest

    bad = {**_VALID_CAPABILITY, "description": "short"}
    with pytest.raises(Exception):
        Capability.model_validate(bad)


def test_capability_too_many_domains() -> None:
    import pytest

    bad = {**_VALID_CAPABILITY, "domains": ["a", "b", "c", "d", "e", "f"]}
    with pytest.raises(Exception):
        Capability.model_validate(bad)


_VALID_BUSINESS = {
    "name": "nexus-council",
    "version": "1.0.0",
    "protocol": "1.0",
    "description": "Multi-domain council with senior advisors and antagonist for strategic review.",
    "domains": ["strategy"],
    "operation_mode": "zero_human",
    "runtime_requirements": {"minimum": [{"runtime": "claude-code"}]},
}


def test_business_manifest_minimal_valid() -> None:
    biz = BusinessManifest.model_validate(_VALID_BUSINESS)
    assert biz.protocol == "1.0"
    assert biz.authority_level == "tier-2"
    assert biz.operation_mode == "zero_human"


def test_business_unknown_feature_rejected() -> None:
    import pytest

    bad = {**_VALID_BUSINESS, "features_required": ["not_a_real_feature"]}
    with pytest.raises(Exception):
        BusinessManifest.model_validate(bad)


def test_business_known_feature_accepted() -> None:
    biz = BusinessManifest.model_validate(
        {**_VALID_BUSINESS, "features_required": ["max_turns", "tool_whitelist"]}
    )
    assert biz.features_required == ["max_turns", "tool_whitelist"]


def test_business_legacy_uuid_validated() -> None:
    import pytest

    bad = {
        **_VALID_BUSINESS,
        "legacy": {"paperclip_company_id": "not-a-uuid"},
    }
    with pytest.raises(Exception):
        BusinessManifest.model_validate(bad)


def test_business_legacy_uuid_accepted() -> None:
    good = {
        **_VALID_BUSINESS,
        "legacy": {"paperclip_company_id": "12345678-1234-1234-1234-123456789012"},
    }
    biz = BusinessManifest.model_validate(good)
    assert biz.legacy is not None
    assert biz.legacy.paperclip_company_id == "12345678-1234-1234-1234-123456789012"


_VALID_EMPLOYEE = {
    "name": "marketing-lead",
    "role": "Marketing Lead",
    "description": "Marketing lead for brand development and campaign execution.",
    "maxTurns": 30,
    "reports_to": "ceo",
    "self_score_contract": {
        "criteria": [
            {"id": "brief_clarity", "description": "Brief is clear", "threshold": 0.8}
        ]
    },
}


def test_employee_minimal_valid() -> None:
    emp = EmployeeFrontmatter.model_validate(_VALID_EMPLOYEE)
    assert emp.type == "functional_specialist"
    assert emp.is_antagonist is False


def test_employee_mind_clone_requires_disclosure() -> None:
    import pytest

    bad = {**_VALID_EMPLOYEE, "type": "mind_clone"}
    with pytest.raises(Exception):
        EmployeeFrontmatter.model_validate(bad)


def test_employee_mind_clone_with_disclosure_ok() -> None:
    good = {**_VALID_EMPLOYEE, "type": "mind_clone", "disclosure_required": True}
    emp = EmployeeFrontmatter.model_validate(good)
    assert emp.disclosure_required is True


def test_employee_max_turns_bounds() -> None:
    import pytest

    with pytest.raises(Exception):
        EmployeeFrontmatter.model_validate({**_VALID_EMPLOYEE, "maxTurns": 0})
    with pytest.raises(Exception):
        EmployeeFrontmatter.model_validate({**_VALID_EMPLOYEE, "maxTurns": 201})


def test_org_chart_must_have_exactly_one_ceo() -> None:
    import pytest

    bad = {
        "chart": [
            {"employee": "alpha", "reports": [], "direct_reports": []},
            {"employee": "beta", "reports": [], "direct_reports": []},
        ]
    }
    with pytest.raises(Exception, match="exactly one"):
        OrgChart.model_validate(bad)


def test_org_chart_one_ceo_ok() -> None:
    chart = OrgChart.model_validate(
        {
            "chart": [
                {"employee": "alpha", "reports": [], "direct_reports": ["beta"]},
                {"employee": "beta", "reports": ["alpha"], "direct_reports": []},
            ]
        }
    )
    assert len(chart.chart) == 2


def _make_business_ctx_for_bp7(num_employees: int, with_antagonist: bool):
    manifest = BusinessManifest.model_validate(_VALID_BUSINESS)
    employees = []
    for i in range(num_employees):
        employees.append(
            EmployeeFrontmatter.model_validate(
                {
                    "name": f"emp-{i}",
                    "role": "Worker",
                    "description": "Worker employee for BP7 violation test scenario.",
                    "maxTurns": 10,
                    "reports_to": None if i == 0 else "emp-0",
                    "is_brief_intake": (i == 0),
                    "is_antagonist": (with_antagonist and i == num_employees - 1),
                    "self_score_contract": {
                        "criteria": [{"id": "x", "description": "x", "threshold": 0.5}]
                    },
                }
            )
        )
    chart = OrgChart.model_validate(
        {
            "chart": [
                {
                    "employee": "emp-0",
                    "reports": [],
                    "direct_reports": [f"emp-{i}" for i in range(1, num_employees)],
                },
                *[
                    {"employee": f"emp-{i}", "reports": ["emp-0"], "direct_reports": []}
                    for i in range(1, num_employees)
                ],
            ]
        }
    )
    return BusinessLoadContext(manifest=manifest, employees=employees, org_chart=chart)


def test_business_integrity_bp7_violation_when_no_antagonist() -> None:
    ctx = _make_business_ctx_for_bp7(num_employees=6, with_antagonist=False)
    result = validate_business_integrity(ctx)
    assert not result.valid
    assert any("BP7" in e for e in result.errors)


def test_business_integrity_bp7_satisfied_when_antagonist_present() -> None:
    ctx = _make_business_ctx_for_bp7(num_employees=6, with_antagonist=True)
    result = validate_business_integrity(ctx)
    bp7_errors = [e for e in result.errors if "BP7" in e]
    assert not bp7_errors


def test_business_integrity_bp7_skipped_for_small_business() -> None:
    ctx = _make_business_ctx_for_bp7(num_employees=3, with_antagonist=False)
    result = validate_business_integrity(ctx)
    bp7_errors = [e for e in result.errors if "BP7" in e]
    assert not bp7_errors


def test_business_integrity_org_chart_unknown_employee() -> None:
    manifest = BusinessManifest.model_validate(_VALID_BUSINESS)
    employees = [
        EmployeeFrontmatter.model_validate(
            {
                **_VALID_EMPLOYEE,
                "name": "emp-0",
                "is_brief_intake": True,
                "reports_to": None,
            }
        )
    ]
    chart = OrgChart.model_validate(
        {
            "chart": [
                {"employee": "emp-0", "reports": [], "direct_reports": ["ghost"]},
            ]
        }
    )
    ctx = BusinessLoadContext(manifest=manifest, employees=employees, org_chart=chart)
    result = validate_business_integrity(ctx)
    assert not result.valid
    assert any("ghost" in e for e in result.errors)


def test_handoff_artifact_minimal_valid() -> None:
    h = HandoffArtifact.model_validate(
        {
            "from_agent": "ceo",
            "to_agent": "specialist",
            "summary": "Briefing inicial passado para specialist começar análise.",
            "next_action": "specialist must produce first draft",
        }
    )
    assert h.from_agent == "ceo"
    assert h.schemaVersion == "1.0.0"


def test_ticket_id_format_required() -> None:
    import pytest

    bad = {
        "ticket_id": "TKT-bad",
        "type": "request",
        "from": "ceo",
        "to": "marketing-lead",
        "project_id": "proj-xyz",
        "business": "nexus-council",
        "subject": "Initial review",
        "body": "Please review the offer.",
        "status": "open",
        "created_at": "2026-05-02T14:00:00Z",
    }
    with pytest.raises(Exception):
        Ticket.model_validate(bad)


def test_ticket_minimal_valid() -> None:
    t = Ticket.model_validate(
        {
            "ticket_id": "TKT-2026-05-02-1",
            "type": "request",
            "from": "ceo",
            "to": "marketing-lead",
            "project_id": "proj-xyz",
            "business": "nexus-council",
            "subject": "Initial review",
            "body": "Please review the offer.",
            "status": "open",
            "created_at": "2026-05-02T14:00:00Z",
        }
    )
    assert t.ticket_id == "TKT-2026-05-02-1"
    assert t.from_ == "ceo"
    assert t.priority == "normal"


def test_audit_event_passthrough_extra_fields() -> None:
    e = AuditEvent.model_validate(
        {
            "ts": "2026-05-02T14:00:00Z",
            "event": "routing_decision",
            "match_score": 0.92,
            "selected_target": "businesses/nexus-council",
        }
    )
    assert e.event == "routing_decision"
    assert e.model_extra is not None
    assert e.model_extra["match_score"] == 0.92


def test_self_score_validates_keys_and_range() -> None:
    import pytest

    s = SelfScore.model_validate({"clarity": 0.9, "feasibility": 0.7, "passes_threshold": True})
    assert s.passes_threshold is True
    assert s.model_extra is not None
    assert s.model_extra["clarity"] == 0.9

    with pytest.raises(Exception):
        SelfScore.model_validate({"clarity": 1.5})

    with pytest.raises(Exception):
        SelfScore.model_validate({"BadKey": 0.5})


def test_harness_config_defaults() -> None:
    cfg = HarnessConfig.model_validate({"version": "1.0"})
    assert cfg.version == "1.0"
    assert cfg.routing is None  # field is Optional, default None


def test_harness_notification_minimal_valid() -> None:
    n = HarnessNotification.model_validate(
        {
            "type": "human_escalation_required",
            "trigger_id": "budget_breach",
            "severity": "high",
            "project_id": "proj-1",
            "context": {"summary": "Budget exceeded by 20%."},
            "options": [{"id": "approve", "description": "Approve overage and continue"}],
        }
    )
    assert n.type == "human_escalation_required"
    assert n.severity == Severity.high


def test_routing_minimal_valid() -> None:
    r = Routing.model_validate(
        {
            "brief_intake": {"default_employee": "ceo"},
            "auto_routes": [
                {"pattern": "(?i)bug|incident", "route_to": "engineer"},
                {"pattern": "(?i)contract", "route_to": "legal", "confidence_threshold": 0.85},
            ],
            "mention_routing": [
                {"mention": "@alex-hormozi", "route_to": "alex-hormozi"}
            ],
            "ticket_intake": {
                "default_assignee": "ceo",
                "by_type": {"bug": "engineer", "approval": "ceo"},
            },
        }
    )
    assert r.brief_intake is not None
    assert r.brief_intake.default_employee == "ceo"
    assert r.auto_routes is not None
    assert r.auto_routes[1].confidence_threshold == 0.85


def test_routing_rejects_bad_mention_pattern() -> None:
    import pytest

    with pytest.raises(Exception):
        Routing.model_validate(
            {"mention_routing": [{"mention": "no-at-sign", "route_to": "x"}]}
        )


def test_routing_ticket_intake_by_type_keys_validated() -> None:
    import pytest

    with pytest.raises(Exception):
        Routing.model_validate(
            {"ticket_intake": {"by_type": {"BadCASE": "ceo"}}}
        )


def test_mention_minimal_valid() -> None:
    m = Mention.model_validate(
        {
            "type": "mention",
            "from": "marketing-lead",
            "to": "alex-hormozi",
            "mention_text": "@alex-hormozi pode revisar o pricing?",
        }
    )
    assert m.from_ == "marketing-lead"
    assert m.type == "mention"


def test_approval_chain_minimal_valid() -> None:
    chain = ApprovalChain.model_validate(
        {
            "chain": [
                {"producer": "marketing-lead", "reviewer": "ceo", "human_checkpoint": "skip"},
                {"approver": "ceo", "final_approver": "ceo", "human_checkpoint": "optional"},
            ],
            "on_approval": "deliver_to_client",
            "on_rejection_at_review": "send_back_to_producer",
            "on_rejection_at_approval": "escalate_to_human",
        }
    )
    assert len(chain.chain) == 2
    assert chain.on_approval == "deliver_to_client"


def test_registry_squads_minimal_valid() -> None:
    reg = RegistrySquads.model_validate(
        {
            "schema_version": "1.0.0",
            "generated_at": "2026-05-02T15:00:00Z",
            "host_protocol_version": "5.0",
            "squads_root_dirs": ["~/squads-v5"],
            "squads": {
                "instagram-intelligence": {
                    "version": "5.4.0",
                    "protocol": "5.0",
                    "manifest_path": "~/squads-v5/instagram-intelligence/squad.yaml",
                    "manifest_hash": "sha256:" + "a" * 64,
                    "domains": ["media", "content"],
                    "capabilities": ["media.video.analyze"],
                }
            },
            "capabilities": {
                "media.video.analyze": [
                    {
                        "squad": "instagram-intelligence",
                        "description": "Analyze video file with multimodal LLM",
                        "domains": ["media", "content"],
                        "fidelity_status": "validated",
                    }
                ]
            },
            "domains": {"media": ["instagram-intelligence"]},
        }
    )
    assert "instagram-intelligence" in reg.squads
    assert "media.video.analyze" in reg.capabilities


def test_registry_squads_rejects_bad_squad_key() -> None:
    import pytest

    with pytest.raises(Exception):
        RegistrySquads.model_validate(
            {
                "schema_version": "1.0.0",
                "generated_at": "2026-05-02T15:00:00Z",
                "host_protocol_version": "5.0",
                "squads_root_dirs": [],
                "squads": {
                    "InvalidName": {
                        "version": "5.0.0",
                        "protocol": "5.0",
                        "manifest_path": "/x.yaml",
                        "manifest_hash": "sha256:" + "0" * 64,
                        "domains": ["x"],
                    }
                },
                "capabilities": {},
            }
        )


def test_registry_squads_rejects_bad_capability_id() -> None:
    import pytest

    with pytest.raises(Exception):
        RegistrySquads.model_validate(
            {
                "schema_version": "1.0.0",
                "generated_at": "2026-05-02T15:00:00Z",
                "host_protocol_version": "5.0",
                "squads_root_dirs": [],
                "squads": {},
                "capabilities": {"only.two": []},
            }
        )


def test_registry_businesses_minimal_valid() -> None:
    reg = RegistryBusinesses.model_validate(
        {
            "schema_version": "1.0.0",
            "generated_at": "2026-05-02T15:00:00Z",
            "businesses_root_dirs": ["~/businesses"],
            "businesses": {
                "nexus-council": {
                    "version": "1.0.0",
                    "protocol": "1.0",
                    "manifest_path": "~/businesses/nexus-council/business.yaml",
                    "manifest_hash": "sha256:" + "b" * 64,
                    "domains": ["strategy"],
                    "capabilities": [],
                    "employee_count": 9,
                    "operation_mode": "zero_human",
                    "authority_level": "tier-2",
                    "legacy_paperclip_id": "12345678-1234-1234-1234-123456789012",
                }
            },
        }
    )
    assert "nexus-council" in reg.businesses
    assert reg.businesses["nexus-council"].employee_count == 9


def test_registry_businesses_rejects_bad_legacy_uuid() -> None:
    import pytest

    with pytest.raises(Exception):
        RegistryBusinesses.model_validate(
            {
                "schema_version": "1.0.0",
                "generated_at": "2026-05-02T15:00:00Z",
                "businesses": {
                    "nexus-council": {
                        "version": "1.0.0",
                        "protocol": "1.0",
                        "manifest_path": "/x.yaml",
                        "manifest_hash": "sha256:" + "c" * 64,
                        "domains": ["strategy"],
                        "capabilities": [],
                        "legacy_paperclip_id": "not-a-uuid",
                    }
                },
            }
        )
