/**
 * Nirvana Protocol Validators (TypeScript / Zod)
 *
 * Fail-closed validators for Squad Protocol v5, Business Protocol v1, and Harness Protocol v1.
 *
 * Used by:
 * - skills/squads (squad.yaml validation, capability validation)
 * - skills/businesses (business.yaml + employee.md + org-chart.yaml validation)
 * - skills/harness (config validation, registry validation, audit event validation)
 *
 * Source schemas:
 * - ~/.nirvana/skills/_shared/schemas/capability.schema.json
 * - ~/.nirvana/skills/_shared/schemas/business.schema.json
 * - ~/.nirvana/skills/_shared/schemas/core-schemas.json
 *
 * Run: bun ~/.nirvana/skills/_shared/validators/validators.ts test
 */

import { z } from 'zod'

// Limites configuráveis (cascata user → project → env). Sem .yaml/env,
// LIMITS == DEFAULTS == valores históricos (backward-compatible).
// Ver limits.ts e _shared/CONFIGURATION.md §Limites configuráveis.
import { LIMITS } from './limits'

// ──────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────

const KEBAB_CASE = /^[a-z][a-z0-9-]{1,63}$/
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/
const CAPABILITY_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/
const SEMVER = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/
const TICKET_ID = /^TKT-\d{4}-\d{2}-\d{2}-\d+$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/
const MENTION = /^@[a-z][a-z0-9-]+$/

const Runtime = z.enum([
  'claude-code', 'codex', 'gemini-cli', 'cursor', 'antigravity', 'antigravity-cli',
  'openclaw', 'opencode',
])
const Model = z.enum(['haiku', 'sonnet', 'opus', 'inherit'])
const Severity = z.enum(['low', 'medium', 'high'])
const FidelityStatus = z.enum(['validated', 'experimental', 'drifted', 'retired'])

const Feature = z.enum([
  // Runtime / control
  'max_turns', 'tool_whitelist', 'subagent_spawning', 'subagents',
  'sequential_execution', 'audit_trail', 'scheduled_invocation', 'event_bus',
  'hooks', 'sandboxing', 'thinking_blocks', 'plugin_sdk',
  // Memory
  'session_memory', 'project_memory', 'global_memory',
  // Handoffs / context
  'handoff_artifacts', 'fork_context', 'teammate_primitive',
  // Observability
  'telemetry_otel', 'feedback_tracking', 'document_revisions', 'execution_workspaces', 'git_isolation',
  // Tool primitives (semantic; runtime-agnostic)
  'file_read', 'file_write', 'shell_exec', 'bash_execution',
  'tools.read', 'tools.write', 'tools.exec',
  // Agent capabilities
  'web_search', 'web_fetch', 'vision_input',
  // Misc
  'native_company_import_export',
])

// ──────────────────────────────────────────────────────────────────────
// Squad Protocol v5
// ──────────────────────────────────────────────────────────────────────

export const CapabilitySchema = z.object({
  id: z.string().regex(CAPABILITY_ID),
  description: z.string().min(20).max(LIMITS.capability_description_max!),
  domains: z.array(z.string().regex(SNAKE_CASE)).min(1).max(5),
  inputs: z.array(z.object({
    name: z.string().regex(SNAKE_CASE),
    type: z.enum(['file', 'string', 'json', 'array', 'number', 'boolean', 'url']),
    formats: z.array(z.string()).optional(),
    schema: z.string().optional(),
    required: z.boolean().default(true),
    description: z.string().optional(),
  }).strict()).optional(),
  outputs: z.array(z.object({
    name: z.string().regex(SNAKE_CASE),
    type: z.enum(['file', 'string', 'json', 'array', 'markdown', 'html', 'binary']),
    format: z.string().optional(),
    schema: z.string().optional(),
    description: z.string().optional(),
  }).strict()).optional(),
  tools_required: z.array(z.string()).optional(),
  invoke: z.object({
    type: z.enum(['workflow', 'task', 'agent']),
    ref: z.string(),
    agent: z.string().optional(),
    prompt_template: z.string().optional(),
    inputs_mapping: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  examples: z.array(z.string().min(5)).min(1),
  produces: z.array(z.string().min(3).max(80)).min(1).max(LIMITS.capability_produces_max!).optional(),
  example_briefs: z.array(z.string().min(20).max(LIMITS.capability_example_briefs_item_max!)).max(LIMITS.capability_example_briefs_max!).optional(),
  keywords: z.array(z.string().min(2).max(60)).max(LIMITS.capability_keywords_max!).optional(),
  not_for: z.array(z.string().min(5)).optional(),
  fidelity: z.object({
    ground_truth_dir: z.string().optional(),
    eval_results: z.string().optional(),
    status: FidelityStatus.default('experimental'),
    last_eval: z.string().datetime().optional(),
    judge_model: z.string().optional(),
    threshold: z.number().min(0).max(1).default(0.85),
  }).strict().optional(),
  score_boost: z.number().min(0).max(2).default(1.0),
  model_hint: Model.default('inherit'),
  estimated_cost_usd: z.number().min(0).optional(),
  parallel_safe: z.boolean().default(false),
  writes_paths: z.array(z.string()).optional(),
  // P0-1: overlay de comportamento. Injeta um fragmento de prompt num role, num
  // hook do ciclo (prompt-assembly time). Ausente = no-op (backward-compat).
  contributions: z.array(z.object({
    into: z.enum(['employee', 'squad', 'mind_clone', 'synthesizer']),
    at: z.enum(['plan:pre', 'execute:pre', 'execute:post', 'verify:pre']),
    fragment: z.object({
      path: z.string().optional(),
      inline: z.string().max(4000).optional(),
    }).refine((f) => !!f.path !== !!f.inline, 'fragment: exatamente um de path|inline'),
    when: z.string().max(200).optional(),
    produces: z.array(z.string()).max(8).optional(),
    consumes: z.array(z.string()).max(8).optional(),
  }).strict()).max(8).optional(),
}).strict()

export const SquadManifestSchema = z.object({
  name: z.string().regex(KEBAB_CASE),
  version: z.string().regex(SEMVER),
  protocol: z.enum(['4.0', '4.1', '5.0']),
  description: z.string().min(20).optional(),
  author: z.string().optional(),
  license: z.string().default('MIT'),
  slashPrefix: z.string().optional(),
  tags: z.array(z.string()).optional(),
  capabilities: z.array(CapabilitySchema).max(LIMITS.squad_capabilities_max!).optional(),
  experimental_domains: z.boolean().default(false),
  components: z.object({
    agents: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    workflows: z.array(z.string()).optional(),
    schemas: z.array(z.string()).optional(),  // JSON Schemas the squad ships for output validation
  }).strict(),
  runtime_requirements: z.object({
    minimum: z.array(z.object({
      runtime: Runtime,
      version: z.string().optional(),
    }).strict()).min(1),
    compatible: z.array(z.unknown()).optional(),
    incompatible: z.array(z.unknown()).optional(),
  }).strict().optional(),
  features_required: z.array(Feature).optional(),
  features_optional: z.array(z.string()).optional(),
  output: z.object({
    base_dir: z.string().default('default'),
  }).strict().optional(),
  legacy: z.object({
    v4_path: z.string().optional(),
  }).passthrough().optional(),
  // Optional squad-level metadata blocks (declarative; carried through validation).
  io: z.object({}).passthrough().optional(),            // I/O contract beyond per-capability inputs/outputs
  memory: z.object({}).passthrough().optional(),        // squad-scoped memory config
  instrumentation: z.object({}).passthrough().optional(), // §26 telemetry opt-in
// Philosophy (b): tolerate unknown top-level keys (user/system extras) instead
// of failing; the capability validator WARNs per unknown key for visibility.
}).passthrough()

// ──────────────────────────────────────────────────────────────────────
// Business Protocol v1
// ──────────────────────────────────────────────────────────────────────

export const SelfScoreContractSchema = z.object({
  required_before_handoff: z.boolean().default(true),
  criteria: z.array(z.object({
    // Fix (2026-05): regex `^[a-z_]+$` bloqueava dígitos não-iniciais
    // (ex.: `iso_42001_compliant`). Agora aceita dígitos após o 1º char.
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string(),
    threshold: z.number().min(0).max(1),
    weight: z.number().min(0).default(1.0),
  }).strict()).min(1),
  on_below_threshold: z.enum(['revise', 'escalate', 'annotate']).default('revise'),
  max_revise_iterations: z.number().int().min(0).max(5).default(2),
}).strict()

export const EscalationTriggerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]+$/),
  // condition + severity are recommended but optional: some triggers are
  // action-only (e.g. an AskUserQuestion gate) and carry no threshold/severity.
  condition: z.string().optional(),
  threshold: z.union([z.number(), z.string()]).optional(),
  currency: z.enum(['USD', 'BRL', 'EUR']).optional(),
  severity: Severity.optional(),
  notify: z.string(),
  action: z.string().optional(),
  options: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  timeout_minutes: z.number().int().min(1).optional(),
  escalate_to: z.string().optional(),
  detect: z.string().optional(),
}).strict()

export const EmployeeFrontmatterSchema = z.object({
  name: z.string().regex(KEBAB_CASE),
  role: z.string().min(2),
  type: z.enum(['functional_specialist', 'mind_clone', 'orchestrator', 'antagonist_gate']).default('functional_specialist'),
  // employee_description_max null (default histórico) => sem teto.
  description: LIMITS.employee_description_max != null
    ? z.string().min(20).max(LIMITS.employee_description_max)
    : z.string().min(20),
  // maxTurns + self_score_contract: default-friendly so older businesses load
  // without a forced rewrite (matches the canonical pydantic defaults).
  maxTurns: z.number().int().min(1).max(LIMITS.employee_max_turns_max!).default(400),
  reports_to: z.union([z.string().regex(/^[a-z][a-z0-9-]+$/), z.null()]).optional(),
  manages: z.array(z.string().regex(/^[a-z][a-z0-9-]+$/)).optional(),
  tools: z.array(z.string()).optional(),
  // model accepts the short enum (sonnet) AND full vendor names (claude-sonnet-4-6).
  model: z.string().optional(),
  budget_monthly_usd: z.number().min(0).optional(),
  heartbeat: z.object({
    cadence: z.enum(['hourly', 'daily', 'weekly', 'manual', 'on-demand']).default('manual'),
    max_cost_per_cycle_usd: z.number().min(0).optional(),
    enabled: z.boolean().default(false),
    on_unproductive_cycle: z.enum(['continue', 'pause_after_n']).optional(),
    pause_after_n_unproductive: z.number().int().min(1).optional(),
  }).strict().optional(),
  is_antagonist: z.boolean().default(false),
  is_brief_intake: z.boolean().default(false),
  antagonizes: z.array(z.string()).optional(),
  squads_authorized: z.array(z.string().regex(KEBAB_CASE)).optional().nullable(),
  draws_from: z.array(z.object({
    source: z.string(),
    weight: z.number().min(0).max(1).optional(),
    use_for: z.array(z.string()).optional(),
  }).strict()).optional(),
  dna_reference: z.string().optional(),
  disclosure_required: z.boolean().optional(),
  commercial_use_allowed: z.enum(['never', 'review', 'allowed']).optional(),
  self_score_contract: SelfScoreContractSchema.optional(),
  memory: z.object({
    permanent_path: z.string().optional(),
  }).strict().optional(),
  mentions: z.object({
    receives: z.array(z.string().regex(MENTION)).optional(),
    notification_priority: z.enum(['high', 'normal', 'low']).default('normal'),
  }).strict().optional(),
  escalation_triggers: z.array(EscalationTriggerSchema).optional(),
  // Council/dispatch employees: which mind-clones they channel and which squad
  // they dispatch. Declared fields in the canonical validators.py.
  mind_clones_used: z.array(z.string()).optional(),
  squad_dispatched: z.array(z.string()).optional(),
  // Fields officialized 2026-05-21 so rich legacy employees (galinha-squads
  // generation) validate without rewrite — mirrors the canonical validators.py.
  effort: z.enum(['low', 'medium', 'high']).optional(),
  authority_level: z.enum(['tier-1', 'tier-2', 'tier-3']).optional(),
  assigned_mind_clones: z.array(z.string()).optional(),
  operation_mode: z.enum(['zero_human', 'hybrid', 'human_in_loop']).optional(),
  secondary_role: z.string().optional(),
}).strict().refine((data) => {
  // BP refinement: mind_clone employees MUST have disclosure_required=true
  if (data.type === 'mind_clone' && !data.disclosure_required) {
    return false
  }
  return true
}, { message: 'mind_clone employees require disclosure_required: true' })

export const BusinessManifestSchema = z.object({
  name: z.string().regex(KEBAB_CASE),
  version: z.string().regex(SEMVER),
  protocol: z.literal('1.0'),
  description: z.string().min(20).max(LIMITS.business_description_max!),
  author: z.string().optional(),
  license: z.string().default('MIT'),
  domains: z.array(z.string().regex(SNAKE_CASE)).min(1).max(50),
  employee_count: z.number().int().min(1).max(100).optional(),
  authority_level: z.enum(['tier-1', 'tier-2', 'tier-3']).default('tier-2'),
  capabilities: z.array(z.string().regex(CAPABILITY_ID)).max(LIMITS.business_capabilities_max!).optional(),
  produces: z.array(z.string().min(3).max(80)).min(1).max(LIMITS.business_produces_max!).optional(),
  example_briefs: z.array(z.string().min(20).max(LIMITS.business_example_briefs_item_max!)).max(LIMITS.business_example_briefs_max!).optional(),
  keywords: z.array(z.string().min(2).max(60)).max(LIMITS.business_keywords_max!).optional(),
  squads_authorized: z.array(z.string().regex(KEBAB_CASE)).optional().nullable(),
  operation_mode: z.enum(['zero_human', 'hybrid', 'human_in_loop']).default('zero_human'),
  output: z.object({
    base_dir: z.string().default('default'),
  }).strict().optional(),
  memory: z.object({
    permanent: z.object({
      enabled: z.boolean().default(true),
      files: z.array(z.string()).optional(),
      garbage_collection: z.object({
        max_facts: z.number().int().min(50).max(LIMITS.business_memory_max_facts_ceiling!).default(500),
        review_interval_days: z.number().int().min(1).max(365).default(60),
        conflict_resolution: z.enum(['replace', 'append', 'prompt']).default('replace'),
      }).strict().optional(),
    }).strict().optional(),
    project: z.object({
      isolation: z.enum(['by_construction', 'advisory']).default('by_construction'),
      layout: z.record(z.string(), z.unknown()).optional(),
    }).strict().optional(),
  }).strict().optional(),
  runtime_requirements: z.object({
    minimum: z.array(z.object({
      runtime: Runtime,
      version: z.string().optional(),
    }).strict()).min(1),
    compatible: z.array(z.unknown()).optional(),
    incompatible: z.array(z.unknown()).optional(),
  }).strict(),
  features_required: z.array(Feature).optional(),
  features_optional: z.array(z.string()).optional(),
  env_required: z.array(z.string().regex(ENV_VAR)).optional(),
  legacy: z.object({
    paperclip_company_id: z.string().uuid().optional(),
    paperclip_instance: z.string().optional(),
    paperclip_data_dir: z.string().optional(),
    migration_date: z.string().datetime().optional(),
    migration_audit_log: z.string().optional(),
  }).passthrough().optional(),
  ui: z.object({
    icon: z.string().optional(),
    category: z.string().optional(),
    client_facing_name: z.string().optional(),
    pitch: z.string().optional(),
    employees_metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
  experimental_domains: z.boolean().default(false),
  // Tolerate richer manifests (auto_routes, squad_dependencies,
  // mind_clone_dependencies, quality_gate, shared_memory, …). These are real,
  // used fields (routing reads auto_routes; councils declare clone deps).
  // Matches the canonical lenient behavior — strict() here rejected valid
  // businesses.
}).passthrough()

export const OrgChartSchema = z.object({
  // Two accepted layouts: the canonical `chart` (list of nodes) and the richer
  // `org` map used by some businesses (e.g. the council). `chart` is optional so
  // org-charts without it don't break; extra keys are allowed (passthrough),
  // matching the canonical pydantic OrgChart (extra="allow").
  chart: z.array(z.object({
    employee: z.string().regex(KEBAB_CASE),
    reports: z.array(z.string()).max(1),
    direct_reports: z.array(z.string()),
    is_antagonist: z.boolean().default(false),
    antagonizes: z.array(z.string()).optional(),
  }).strict()).min(1).optional(),
  org: z.record(z.string(), z.unknown()).optional(),
  routing_rules: z.object({
    escalation_path: z.record(z.string(), z.string()).optional(),
    default_skip_levels: z.boolean().default(false),
    cross_team_handoff_allowed: z.boolean().default(true),
    antagonist_invocation: z.object({
      triggers: z.array(z.string()).optional(),
    }).strict().optional(),
    // Human/employee sign-off required before a sensitive action.
    approval_gates: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict().optional(),
}).passthrough().refine((data) => {
  // When the canonical `chart` is present, exactly one CEO (reports = []).
  if (!data.chart) return true
  const ceos = data.chart.filter(e => e.reports.length === 0)
  return ceos.length === 1
}, { message: 'Org chart must have exactly one employee with reports: []' })

// ──────────────────────────────────────────────────────────────────────
// Handoff Artifact (Squad v4 §9 + Business v1 §10.6)
// ──────────────────────────────────────────────────────────────────────

// Fix (2026-05): regex alinhada com SelfScoreCriterion.id (aceita dígitos não-iniciais).
export const SelfScoreSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.number().min(0).max(1))
  .and(z.object({
    passes_threshold: z.boolean().optional(),
    iteration: z.number().int().min(0).optional(),
    justifications: z.record(z.string(), z.string()).optional(),
  }))

export const HandoffArtifactSchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  from_agent: z.string(),
  to_agent: z.string(),
  summary: z.string().min(10).max(LIMITS.handoff_summary_max!),
  // key_decisions/blockers hard-coded (feature: força priorização).
  key_decisions: z.array(z.string()).max(5).optional(),
  files_modified: z.array(z.string()).max(LIMITS.handoff_files_modified_max!).optional(),
  blockers: z.array(z.string()).max(3).optional(),
  next_action: z.string(),
  artifacts: z.array(z.string()).optional(),
  business_extensions: z.object({
    type: z.enum(['mention', 'ticket', 'escalation', 'delegation', 'auto_route']),
    mention_text: z.string().optional(),
    ticket_id: z.string().optional(),
    project_id: z.string().optional(),
    business_slug: z.string().optional(),
    self_score: SelfScoreSchema.optional(),
    expected_response: z.string().optional(),
    deadline: z.string().datetime().optional(),
    audit_trail_id: z.string().optional(),
    humanized: z.boolean().optional(),
  }).strict().optional(),
}).strict()

export const TicketSchema = z.object({
  ticket_id: z.string().regex(TICKET_ID),
  schemaVersion: z.string().default('1.0.0'),
  type: z.enum(['request', 'review', 'approval', 'bug', 'escalation']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  from: z.string(),
  to: z.string(),
  project_id: z.string(),
  business: z.string(),
  subject: z.string().min(5),
  body: z.string(),
  expected_output: z.object({
    type: z.enum(['approval', 'revisions', 'rejection', 'deliverable', 'decision']),
    schema: z.string().optional(),
  }).strict().optional(),
  due_date: z.string().datetime().optional(),
  self_score: SelfScoreSchema.optional(),
  linked_handoff: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'resolved', 'rejected', 'paused', 'cancelled']),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable().optional(),
  history: z.array(z.object({
    event: z.string(),
    by: z.string(),
    at: z.string().datetime(),
  }).strict()).optional(),
}).strict()

// ──────────────────────────────────────────────────────────────────────
// Harness Protocol v1
// ──────────────────────────────────────────────────────────────────────

export const HarnessConfigSchema = z.object({
  version: z.literal('1.0'),
  routing: z.object({
    match_high_threshold: z.number().default(0.80),
    match_high_lead: z.number().default(0.15),
    match_ambiguous_threshold: z.number().default(0.60),
    match_ambiguous_window: z.number().default(0.15),
    tier2_embedding: z.enum(['disabled', 'enabled']).default('disabled'),
    tier2_provider: z.string().optional(),
    tier2_threshold: z.number().optional(),
    auto_invoke_validated_capabilities: z.boolean().default(true),
    auto_invoke_budget_usd: z.number().default(1.00),
  }).strict().optional(),
  budget: z.object({
    // Defaults configuráveis via nirvana-limits.yaml (EXECUTION CONTROL).
    default_max_cost_usd: z.number().default(LIMITS.harness_default_max_cost_usd!),
    default_max_tokens: z.number().int().default(LIMITS.harness_default_max_tokens!),
    default_max_handoffs: z.number().int().default(LIMITS.harness_default_max_handoffs!),
    default_max_duration_seconds: z.number().int().default(LIMITS.harness_default_max_duration_seconds!),
    on_budget_exceeded: z.enum(['abort', 'warn', 'escalate']).default('abort'),
  }).strict().optional(),
  telemetry: z.object({
    provider: z.enum(['otel', 'jsonl', 'none']).default('otel'),
    otlp_endpoint: z.string().optional(),
    fallback_jsonl_path: z.string().default('~/.harness-logs/'),
    service_name: z.string().default('harness'),
  }).strict().optional(),
  memory: z.object({
    isolation_enforcement: z.enum(['strict', 'advisory']).default('strict'),
  }).strict().optional(),
  audit: z.object({
    enabled: z.boolean().default(true),
    project_retention_days: z.number().int().default(365),
    session_retention_days: z.number().int().default(90),
    on_expiry: z.enum(['archive', 'delete', 'rotate']).default('archive'),
  }).strict().optional(),
  skills: z.object({
    squads_dir: z.string().default('~/squads-v5'),
    squads_legacy_dir: z.string().default('~/squads'),
    businesses_dir: z.string().default('~/businesses'),
  }).strict().optional(),
}).strict()

export const AuditEventSchema = z.object({
  ts: z.string().datetime(),
  event: z.enum([
    'brief_received', 'routing_decision', 'invocation_start', 'invocation_end',
    'cost_emission', 'handoff', 'ticket_opened', 'ticket_resolved',
    'escalation_trigger_fired', 'human_notification_required', 'human_response_received',
    'resume', 'approval_checkpoint', 'approval_granted', 'approval_rejected',
    'budget_violation', 'memory_write', 'isolation_violation', 'validation_failed',
    'humanization_applied', 'humanization_skipped',
  ]),
  trace_id: z.string().optional(),
  project_id: z.string().optional(),
  business_slug: z.string().optional(),
  squad_name: z.string().optional(),
  agent_or_employee: z.string().optional(),
}).passthrough() // allow extra fields per event type

export const HarnessNotificationSchema = z.object({
  schema_version: z.string().default('1.0.0'),
  type: z.literal('human_escalation_required'),
  trigger_id: z.string(),
  severity: Severity,
  project_id: z.string(),
  business_slug: z.string().optional(),
  context: z.object({
    summary: z.string(),
    current_invocation: z.string().optional(),
    audit_log_excerpt: z.string().optional(),
  }).strict(),
  options: z.array(z.object({
    id: z.string(),
    description: z.string(),
  }).strict()).min(1),
  timeout_minutes: z.number().int().min(1).optional(),
  default_on_timeout: z.string().optional(),
}).strict()

// ──────────────────────────────────────────────────────────────────────
// Routing (Business Protocol v1 §13)
// ──────────────────────────────────────────────────────────────────────

export const RoutingSchema = z.object({
  brief_intake: z.object({
    default_employee: z.string(),
    alternates: z.array(z.object({
      condition: z.string(),
      route_to: z.string(),
      bypass_auto_routes: z.boolean().default(false),
    }).strict()).optional(),
  }).strict().optional(),
  auto_routes: z.array(z.object({
    pattern: z.string(),
    route_to: z.string(),
    confidence_threshold: z.number().default(0.7),
    requires_escalation_to: z.string().optional(),
  }).strict()).optional(),
  mention_routing: z.array(z.object({
    mention: z.string().regex(MENTION),
    route_to: z.string(),
  }).strict()).optional(),
  ticket_intake: z.object({
    default_assignee: z.string().optional(),
    by_type: z.record(z.string().regex(/^[a-z_]+$/), z.string()).optional(),
  }).strict().optional(),
}).strict()

// ──────────────────────────────────────────────────────────────────────
// Mention (Business Protocol v1 §10.1)
// ──────────────────────────────────────────────────────────────────────

export const MentionSchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  type: z.literal('mention'),
  from: z.string(),
  to: z.string(),
  mention_text: z.string(),
  context_path: z.string().optional(),
  self_score: SelfScoreSchema.optional(),
  expected_response: z.string().optional(),
  deadline: z.string().datetime().optional(),
}).strict()

// ──────────────────────────────────────────────────────────────────────
// Approval Chain (Business Protocol v1 §14.3)
// ──────────────────────────────────────────────────────────────────────

export const ApprovalChainSchema = z.object({
  chain: z.array(z.object({
    producer: z.string().optional(),
    reviewer: z.string().optional(),
    approver: z.string().optional(),
    final_approver: z.string().optional(),
    human_checkpoint: z.enum(['required', 'optional', 'skip']).optional(),
  }).strict()).min(1),
  on_approval: z.enum(['deliver_to_client', 'merge_to_final', 'publish', 'notify']).optional(),
  on_rejection_at_review: z.enum(['send_back_to_producer', 'escalate', 'abort']).optional(),
  on_rejection_at_approval: z.enum(['send_back_to_producer', 'escalate_to_human', 'abort']).optional(),
}).strict()

// ──────────────────────────────────────────────────────────────────────
// Registries (Squad v5 §23)
// ──────────────────────────────────────────────────────────────────────

export const RegistrySquadsSchema = z.object({
  schema_version: z.string().default('1.0.0'),
  generated_at: z.string().datetime(),
  host_protocol_version: z.enum(['5.0', '4.0']),
  squads_root_dirs: z.array(z.string()),
  squads: z.record(
    z.string().regex(/^[a-z][a-z0-9-]+$/),
    z.object({
      version: z.string(),
      protocol: z.string(),
      manifest_path: z.string(),
      manifest_hash: z.string().regex(SHA256),
      domains: z.array(z.string()),
      capabilities: z.array(z.string()).optional(),
    }).strict(),
  ),
  capabilities: z.record(
    z.string().regex(CAPABILITY_ID),
    z.array(z.object({
      squad: z.string(),
      description: z.string(),
      domains: z.array(z.string()),
      examples: z.array(z.string()).optional(),
      not_for: z.array(z.string()).optional(),
      fidelity_status: FidelityStatus.optional(),
      invoke: z.record(z.string(), z.unknown()).optional(),
      score_boost: z.number().default(1.0),
    }).strict()),
  ),
  domains: z.record(z.string().regex(SNAKE_CASE), z.array(z.string())).optional(),
  bm25_index: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const RegistryBusinessesSchema = z.object({
  schema_version: z.string().default('1.0.0'),
  generated_at: z.string().datetime(),
  businesses_root_dirs: z.array(z.string()).optional(),
  businesses: z.record(
    z.string().regex(/^[a-z][a-z0-9-]+$/),
    z.object({
      version: z.string(),
      protocol: z.literal('1.0'),
      manifest_path: z.string(),
      manifest_hash: z.string().regex(SHA256),
      domains: z.array(z.string()),
      capabilities: z.array(z.string()),
      employee_count: z.number().int().optional(),
      operation_mode: z.enum(['zero_human', 'hybrid', 'human_in_loop']).optional(),
      authority_level: z.enum(['tier-1', 'tier-2', 'tier-3']).optional(),
      legacy_paperclip_id: z.string().uuid().optional(),
      // Agentic-discovery metadata (Business Protocol v1 — optional).
      produces: z.array(z.string()).optional(),
      example_briefs: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
    }).strict(),
  ),
}).strict()

// ──────────────────────────────────────────────────────────────────────
// Cross-protocol cross-checks (BP7, BP9, etc.)
// ──────────────────────────────────────────────────────────────────────

export interface BusinessLoadContext {
  manifest: z.infer<typeof BusinessManifestSchema>
  employees: Array<z.infer<typeof EmployeeFrontmatterSchema>>
  org_chart: z.infer<typeof OrgChartSchema>
}

export function validateBusinessIntegrity(ctx: BusinessLoadContext): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // BP7: businesses with > 5 employees MUST have antagonist
  if (ctx.employees.length > 5) {
    const antagonists = ctx.employees.filter(e => e.is_antagonist)
    if (antagonists.length === 0) {
      errors.push('BP7 violation: businesses with > 5 employees require at least 1 employee with is_antagonist: true')
    }
  }

  // Exactly one brief_intake
  const intakes = ctx.employees.filter(e => e.is_brief_intake)
  if (intakes.length !== 1) {
    errors.push(`Exactly one employee must have is_brief_intake: true (found ${intakes.length})`)
  }

  // Org chart consistency: every employee in chart exists in employees[].
  // The alternative `org:` layout (chart=None) exposes no chart nodes; in that
  // case the chart-based checks are skipped (no graph to validate) — mirrors the
  // canonical `chart = ctx.org_chart.chart or []` behavior.
  const employeeNames = new Set(ctx.employees.map(e => e.name))
  const chart = ctx.org_chart.chart ?? []
  for (const node of chart) {
    if (!employeeNames.has(node.employee)) {
      errors.push(`Org chart references unknown employee: ${node.employee}`)
    }
    for (const reportTo of node.reports) {
      if (!employeeNames.has(reportTo)) {
        errors.push(`Employee ${node.employee} reports to unknown: ${reportTo}`)
      }
    }
    for (const directReport of node.direct_reports) {
      if (!employeeNames.has(directReport)) {
        errors.push(`Employee ${node.employee} manages unknown: ${directReport}`)
      }
    }
  }

  // Bidirectional reporting consistency
  for (const node of chart) {
    for (const directReport of node.direct_reports) {
      const child = chart.find(c => c.employee === directReport)
      if (child && !child.reports.includes(node.employee)) {
        errors.push(`Bidirectional inconsistency: ${node.employee} manages ${directReport} but ${directReport} doesn't report to ${node.employee}`)
      }
    }
  }

  // No cycles (DFS)
  const visited = new Set<string>()
  const recursing = new Set<string>()
  function detectCycle(name: string): boolean {
    if (recursing.has(name)) return true
    if (visited.has(name)) return false
    visited.add(name); recursing.add(name)
    const node = chart.find(c => c.employee === name)
    if (node) {
      for (const child of node.direct_reports) {
        if (detectCycle(child)) return true
      }
    }
    recursing.delete(name)
    return false
  }
  for (const node of chart) {
    if (detectCycle(node.employee)) {
      errors.push(`Org chart cycle detected starting at ${node.employee}`)
      break
    }
  }

  // Manifest employee_count matches
  if (ctx.manifest.employee_count && ctx.manifest.employee_count !== ctx.employees.length) {
    errors.push(`Manifest employee_count (${ctx.manifest.employee_count}) doesn't match actual count (${ctx.employees.length})`)
  }

  return { valid: errors.length === 0, errors }
}

// ──────────────────────────────────────────────────────────────────────
// Self-test
// ──────────────────────────────────────────────────────────────────────

if (typeof process !== 'undefined' && process.argv[2] === 'test') {
  const sampleCapability = {
    id: 'media.video.analyze',
    description: 'Analyze video file with multimodal LLM. Extracts transcript, on-screen text, key frames, hook analysis.',
    domains: ['media', 'content'],
    invoke: { type: 'task', ref: 'tasks/analyze.md' },
    examples: ['transcrever vídeo do Instagram'],
  }
  const result = CapabilitySchema.safeParse(sampleCapability)
  console.log('Capability validation:', result.success ? 'OK' : result.error)

  // Strict mode test
  const strictTest = CapabilitySchema.safeParse({ ...sampleCapability, ghost_field: 'should fail' })
  console.log('Strict mode rejects extras:', strictTest.success ? 'FAIL (accepted extras)' : 'OK (rejected)')

  // Features whitelist test
  const featTest = BusinessManifestSchema.safeParse({
    name: 'test-biz',
    version: '1.0.0',
    protocol: '1.0',
    description: 'Test business with features list to validate whitelist enforcement.',
    domains: ['test'],
    runtime_requirements: { minimum: [{ runtime: 'claude-code' }] },
    features_required: ['not_a_real_feature'],
  })
  console.log('Features whitelist rejects unknown:', featTest.success ? 'FAIL' : 'OK')

  // New schemas smoke (Onda 1.1)
  const routingTest = RoutingSchema.safeParse({
    brief_intake: { default_employee: 'ceo' },
    auto_routes: [{ pattern: '(?i)bug', route_to: 'engineer' }],
  })
  console.log('Routing schema:', routingTest.success ? 'OK' : 'FAIL')

  const mentionTest = MentionSchema.safeParse({
    type: 'mention',
    from: 'a',
    to: 'b',
    mention_text: '@b please review',
  })
  console.log('Mention schema:', mentionTest.success ? 'OK' : 'FAIL')

  const approvalTest = ApprovalChainSchema.safeParse({
    chain: [{ producer: 'a', reviewer: 'b', human_checkpoint: 'skip' }],
    on_approval: 'deliver_to_client',
  })
  console.log('ApprovalChain schema:', approvalTest.success ? 'OK' : 'FAIL')

  const regSquadsTest = RegistrySquadsSchema.safeParse({
    generated_at: '2026-05-02T15:00:00Z',
    host_protocol_version: '5.0',
    squads_root_dirs: ['/x'],
    squads: {
      'instagram-intelligence': {
        version: '5.4.0',
        protocol: '5.0',
        manifest_path: '/x.yaml',
        manifest_hash: 'sha256:' + 'a'.repeat(64),
        domains: ['media'],
      },
    },
    capabilities: {
      'media.video.analyze': [{
        squad: 'instagram-intelligence',
        description: 'analyze',
        domains: ['media'],
      }],
    },
  })
  console.log('RegistrySquads schema:', regSquadsTest.success ? 'OK' : 'FAIL')

  const regBizTest = RegistryBusinessesSchema.safeParse({
    generated_at: '2026-05-02T15:00:00Z',
    businesses: {
      'nexus-council': {
        version: '1.0.0',
        protocol: '1.0',
        manifest_path: '/x.yaml',
        manifest_hash: 'sha256:' + 'b'.repeat(64),
        domains: ['strategy'],
        capabilities: [],
      },
    },
  })
  console.log('RegistryBusinesses schema:', regBizTest.success ? 'OK' : 'FAIL')
}
