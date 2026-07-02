# Step-by-step tutorial · businesses skill

> Journey from zero to your first real business deliverable. Approximately 30 minutes to complete.

This tutorial assumes Node 18+, Python 3.9+, and the skill installed at `~/.claude/skills/businesses/`.

---

## Tutorial scenario

You are the founder of a SaaS product called **Beta Studio** (an online video production course). You want an "internal agency" that handles content, sales, and support. You will create a business with 4 employees: CEO, Marketing Lead, Sales Lead, and a QA Antagonist.

By the end of the tutorial you will have:
- The `beta-studio` business validated and indexed
- 4 employees with self-score contracts and bridges
- One brief dispatched
- An audit log of what happened

---

## Step 1 — Inspect what already exists

Before creating anything, check the current portfolio.

```bash
bun ~/.claude/skills/businesses/scripts/list-businesses.ts
```

Expected output:
```
Total: 31 valid businesses · 328 employees
  - agency-hq (12 emp)
  - authority-engine (13 emp)
  - ...
  - nexus-council (9 emp)
```

Copy an example for inspiration:

```bash
bun ~/.claude/skills/businesses/scripts/inspect-business.ts nexus-council
```

You will see hierarchy, employees with roles, intake, antagonist. Use it as reference.

---

## Step 2 — Create the business via wizard

```bash
bun ~/.claude/skills/businesses/scripts/init-business.ts beta-studio --template council
```

The wizard asks 4 rounds of questions:

**Round 1 — Identity**
- Canonical name: `beta-studio`
- Display name: `Beta Studio`
- Short pitch: `Video production courses with mind-clones of top cinematographers`
- Domains (comma-separated): `education, video, content, sales`

**Round 2 — Runtime + budget**
- Minimum runtime: `claude-code`
- Total monthly budget: `$200`
- Operation mode: `zero_human`

**Round 3 — Employees**
Add 4:
1. `beta-ceo` — role: `ceo`, reports_to: empty (CEO is root)
2. `beta-marketing-lead` — role: `marketing-lead`, reports_to: `beta-ceo`
3. `beta-sales-lead` — role: `sales-lead`, reports_to: `beta-ceo`
4. `beta-qa` — role: `qa` (auto-promoted to antagonist), reports_to: `beta-ceo`

**Round 4 — Initial routing**
Add 2 auto_routes:
- `type:course-launch` → `beta-marketing-lead`
- `type:refund-request` → `beta-sales-lead` (with escalation to `beta-ceo`)

Output:
```
✅ Created ~/businesses/beta-studio/
   - business.yaml
   - employees/{beta-ceo, beta-marketing-lead, beta-sales-lead, beta-qa}.md
   - org-chart.yaml
   - routing.yaml
   - memory/permanent.md
```

---

## Step 3 — Inspect what the wizard generated

```bash
ls -la ~/businesses/beta-studio/
cat ~/businesses/beta-studio/business.yaml
```

The `business.yaml` should have:
```yaml
name: beta-studio
version: 1.0.0
protocol: "1.0"
description: "Video production courses with mind-clones of top cinematographers"
domains: [education, video, content, sales]
employee_count: 4
authority_level: tier-2
operation_mode: zero_human
runtime_requirements:
  minimum:
    - runtime: claude-code
```

Look at one employee:

```bash
sed -n '1,/^---$/p' ~/businesses/beta-studio/employees/beta-ceo.md
```

You will see the full frontmatter: `name, role, type: functional_specialist, description, maxTurns, reports_to: null, self_score_contract` (template `ceo.yaml` applied).

---

## Step 4 — Validate before anything else

```bash
bun ~/.claude/skills/businesses/scripts/validate-business.ts ~/businesses/beta-studio
```

Expected output:
```
OK: beta-studio v1.0.0
  protocol: 1.0
  domains: [education, video, content, sales]
  employees: 4
  brief_intake: beta-ceo
  antagonists: [beta-qa]
  org_chart nodes: 4
  routing: present
```

If a **BP7 violation** appears ("businesses with > 5 employees require ≥1 antagonist"): in our case we only have 4 employees, so it does not apply. If you accidentally added 2+ more employees, set `is_antagonist: true` on one of them.

---

## Step 5 — Index into the registry

```bash
bun ~/.claude/skills/businesses/scripts/index-businesses.ts
```

Output:
```
OK: registry written to ${BUSINESSES_REGISTRY_PATH}
   32 valid businesses indexed, 0 invalid
   - beta-studio v1.0.0 (protocol 1.0, employees 4, mode zero_human)
   - ...
```

Now `beta-studio` shows up in the list.

---

## Step 6 — Confirm via inspect

```bash
bun ~/.claude/skills/businesses/scripts/inspect-business.ts beta-studio
```

Output:
```
=== beta-studio v1.0.0 ===
Path:           ${BUSINESSES_DIR}/beta-studio
Protocol:       1.0
Description:    Video production courses with mind-clones of top cinematographers
Domains:        education, video, content, sales
Authority:      tier-2
Operation:      zero_human
Employees:      4

--- Employees ---
  beta-ceo                role=ceo  reports_to=<root>  maxTurns=80  [intake]
  beta-marketing-lead     role=marketing-lead  reports_to=beta-ceo  maxTurns=100
  beta-sales-lead         role=sales-lead  reports_to=beta-ceo  maxTurns=100
  beta-qa                 role=qa  reports_to=beta-ceo  maxTurns=80  [antagonist]

--- Org Chart ---
beta-ceo (manages: beta-marketing-lead, beta-sales-lead, beta-qa)
  beta-marketing-lead (manages: -)
  beta-sales-lead (manages: -)
  beta-qa (manages: -)
```

---

## Step 7 — Confirm discovery via harness

```bash
bun ~/.claude/skills/harness/scripts/find.ts "launch a new filmmaking course"
```

Stage 0 of the harness should detect `type:course-launch` in `beta-studio`'s auto_route and return:

```
signal: HIGH
top-match: business_route:beta-studio:beta-marketing-lead:type:course-launch
```

If it does not return that: review `~/businesses/beta-studio/routing.yaml` and re-run `index-businesses.ts`.

---

## Step 8 — Dispatch the first brief

```bash
bun ~/.claude/skills/businesses/scripts/brief-business.ts beta-studio "Launch the new course 'Digital Cinematography 2026'"
```

Output:
```
Project ID: proj-20260502T230015-beta-studio
Brief saved: ~/.projects-outputs/proj-20260502T230015-beta-studio/brief.md
Project dir: ~/.projects-outputs/proj-20260502T230015-beta-studio/businesses/beta-studio/
Audit log:   ~/.projects-outputs/proj-20260502T230015-beta-studio/businesses/beta-studio/audit.jsonl

Next step (executed by the skill via Agent tool):
  Spawn employee 'beta-ceo' with the brief above as context.
  Wait for handoff_artifact in handoffs/.
```

From here, in a real Claude Code session, you would ask Claude:

> Spawn beta-ceo (from ~/businesses/beta-studio/employees/beta-ceo.md) as a subagent with the brief at ~/.projects-outputs/proj-…/brief.md and give me its handoff_artifact.

Claude will:
1. Read the beta-ceo employee.md (frontmatter + body)
2. Spawn it as `Agent({subagent_type: "beta-ceo", ...})`
3. beta-ceo decides: delegate to marketing-lead (for the launch), receive deliverables, synthesize, return a handoff_artifact with self-score.

---

## Step 9 — Inspect the audit trail

```bash
ls ~/.projects-outputs/proj-20260502T230015-beta-studio/
cat ~/.projects-outputs/proj-20260502T230015-beta-studio/businesses/beta-studio/audit.jsonl
```

Each event (brief_received, invocation_start, handoff, ticket_opened, etc.) is recorded as JSONL, schema-validated.

---

## Step 10 — Iterate the manifest

As you use it, you will want to adjust:

- **Add new employee**: create a `.md` in `employees/`, add to `org-chart.yaml`, re-validate, re-index.
- **Add auto_route**: edit `routing.yaml`, re-validate, re-index. Stage 0 of the harness picks it up immediately.
- **Switch intake**: set `is_brief_intake: false` on the old one, `true` on the new one. Validator accepts exactly 1.
- **Customize self-score template**: copy a yaml from `~/migration-tools/templates/self-score/` to `<more-specific-role>.yaml` and `pickSelfScoreTemplate` will pick it up via substring on the next migration.

---

## Tutorial troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `validate-business.ts` complains about `bidirectional inconsistency` | manages and reports_to do not match | Edit `org-chart.yaml`: if A.direct_reports includes B, then B.reports must contain A |
| `BP7 violation` | >5 employees without antagonist | Set `is_antagonist: true` on one (preference: `qa` role) |
| `Slug must match ^[a-z][a-z0-9-]{1,63}$` | uppercase or special character | kebab-case only |
| Harness does not route to your business | Forgot to re-index after editing | `bun scripts/index-businesses.ts` |
| Description rejected with `minLength: 20` | Text too short | minimum 20 chars in business and employee `description` |

---

## Next steps

- Migrate an existing company (paperclip → business v1) using `~/migration-tools/paperclip-to-business-v1.ts`
- Compose a multi-business brief via the `business-nirvana-maestro` squad (in `${MAESTRO_DIR}/`)
- Customize self-score templates for roles specific to your business
- Connect bridges to squads (in `bridges/squad-bridges.yaml`) so employees can invoke external squads

See the skill's `README.md` for a full reference of CLI, programmatic API, and architecture.
