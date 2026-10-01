# example-solo · Solo business template

This directory is a runnable template for a minimal valid business (1 CEO employee who takes the brief, works it and delivers).

## Structure

```
example-business/
├── business.yaml                 # manifest protocol 2.0
├── org-chart.yaml                # hierarchy (CEO with no reports)
├── routing.yaml                  # brief_intake → ceo
├── employees/
│   └── ceo.md                    # CEO with acceptance + brief_intake=true
├── memory/
│   └── permanent.md              # cross-session memory (skeleton)
└── README.md                     # this file
```

## How to use this template

Do not modify this directory. Use it as a reference or a starting point:

```bash
# Via wizard:
*business init my-company --template solo

# Or copy by hand:
cp -R ~/.nirvana/skills/businesses/templates/example-business ~/businesses/my-company
# Edit ~/businesses/my-company/business.yaml and adjust name, domains, description.
# Edit ~/businesses/my-company/employees/ceo.md (description, acceptance entries).
# Validate:
nrv validate business my-company --strict
```

## Validation

This template passes the admission gate (`nrv validate business <slug>`):

- Manifest valid against the executed Zod schema (`_shared/validators/validators.ts`).
- Exactly 1 brief_intake (ceo).
- BP7 not applicable (1 employee, no antagonist needed).
- Org chart without cycles, exactly 1 CEO (`reports: []`).
- `acceptance` block with 3 criteria on the intake seat (v2 §11).

## Other templates

- `template council`: 5 advisors + 1 CEO (council strategy review)
- `template agency`: CEO + 4-7 specialists + 1 antagonist (agency model with BP7 satisfied)
- `template custom`: the wizard asks everything

The full wizard flow is in `SKILL.md` (§Wizard flow).
