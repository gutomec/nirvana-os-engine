# Teams · the library's roles as a host's agents

> A team is a set of agents built from the library: each role comes from an
> employee of an installed business, each persona from a mind-clone, and a role
> no business has is an **expert-x**. It exists for hosts that show each agent
> working (OpenBot) or load agents per project (Claude Code). Nothing here runs
> unless someone asks for a team: `nrv dispatch` never reads one.
>
> Code: `_shared/lib/team.ts` (the file and what a member is told),
> `_shared/lib/team-hosts.ts` (where it is written), `harness/scripts/team.ts`
> (`nrv team`).

---

## 1. The team file

`.nirvana/team.yaml`, in a project folder or, by slug, under
`~/.nirvana/teams/<slug>/`. The user's main agent writes and edits it; the
engine validates and compiles it.

```yaml
team: studio
display_name: "Studio"
purpose: "Designs and launches a product."
orchestrator: director        # receives the request and runs the project
reviewer: reviewer            # optional; never the orchestrator
members:
  - id: director
    name: "Director"          # the name the host shows; unique in the team
    tier: lead                # lead or member
    role_from: fintech-forge/ff-product-director
    clones: [marty-cagan]
  - id: risk
    name: "Credit Risk"
    reports_to: director
    expert:                   # an expert-x: no employee in the library
      role: "Credit risk for the MVP"
      delivers: "The risk model and the credit policy"
      done_when: "Each rule has its source and a worked example"
models:                       # optional; printed for whoever creates the agents
  lead: { provider: claude, model: claude-opus-5-5, effort: high }
```

A file with a problem writes nothing. Every problem is named: an employee or a
clone that is not installed, a name used twice, a reporting line that loops, an
expert-x with a clone, a reviewer that is the orchestrator.

## 2. Who fills a role

In this order: an employee with a clone that fits; the employee without a
clone; an expert-x with a three-line card; or asking the person to create the
clone first, when the role is central. `nrv find-clone` offers only clones that
cover the need. An expert-x gets no persona and no method, so the model works
freely; the lead's review and the reviewer hold the quality.

## 3. What every member is told

Its role (the employee file's text and acceptance criteria, or the card), its
clone's files by path, who it answers to and who answers to it, and the rules
below. They come from a 15-agent team that ran a full project on OpenBot on
2026-11-24/25.

| Rule | What happened without it |
|---|---|
| Effort fits the question | A member downloaded gigabytes of public records for one market count |
| Never end a turn waiting on something nobody will wake you for | That download outlived the turn: 35 minutes with nobody working |
| The machine is its owner's: no applications, services or installs unasked | A member opened Docker Desktop on a machine with no room for it |
| The reviewer reviews a list of files, in one pass | The reviewer re-read the project and cost the most without finishing |
| One decision point: scope and cost, before the long part | The budget question arrived three times, each with new numbers |
| The orchestrator asks once for a late answer, then goes on | A chain of three waited in silence |

## 4. Hosts

| Host | Where the team goes | Who creates the agents |
|---|---|---|
| Claude Code | `.claude/agents/<team>-<id>.md`, one subagent per member, loaded when the project opens. The orchestrator is the main session: `.nirvana/team/director.md` | Nobody: the files are the agents |
| OpenBot (Nightly Labs) | One marked section in the `AGENTS.md` of the agent that carries the member's name; the generic Nirvana-OS section is taken out of it | The host's own agent, with `create_agent`: the engine only reads the app's database. `nrv team sync` names the agents to create |
| Any other | `<team folder>/.nirvana/team/members/<id>.md`, always written | Whoever points the host at those files |

On OpenBot an agent belongs to one team at a time. A member taken out of the
file, or a removed team, has its section taken out; the agent is never deleted
and goes back to the generic section on the engine's next run.

## 5. Known limits

- The engine does not decide the team: `nrv team candidates` is a keyword
  shortlist and the agent chooses the roles.
- A team's delivery does not go through the engine's quality gate or its audit
  chain; `x_team_synced` and `x_team_removed` are the only audit events. The
  reviewer is a member of the team.
- OpenMausBot has no adapter yet: point its bots at the neutral files.
- Measured once, on one project: 15 agents, about 2 h 40 min and about US$ 101
  at list prices for 247 files. The rules of §3 were written after that run and
  have not been measured yet.
