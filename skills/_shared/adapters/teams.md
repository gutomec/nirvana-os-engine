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

## 4a. A squad as a workflow: `nrv team flow`

A squad that declares a workflow (`workflows/<name>.md`, steps with `id`,
`agent` and `requires`) can be drawn as a workflow of OpenBot: a node per step,
the person's approval before the result goes out, and a trigger they can put on
a schedule. Code: `_shared/lib/team-flow.ts`. It is for the squad the person
runs again and again and wants to watch; a squad they just want done is one
`nrv dispatch`, which keeps the engine's gate and audit.

```
nrv team flow <squad> [--workflow <name>]      the plan: steps, and the edit_workflow call that builds it
nrv team flow <squad> --created <workflowId>   record the workflow the agent built
nrv team flow --list                           the workflows recorded for this agent, and which are stale
nrv team flow <squad> --forget                 take them out of the agent's instructions
```

- **The engine plans, the agent builds.** OpenBot's database is the app's own,
  so the engine writes no workflow. It prints the `ops` of one `edit_workflow`
  call: a manual trigger, an `agent` node per step linked as `requires` says,
  an `approval` node after the last steps and an `output` node. The agent that
  ran the command makes the call, in a turn its person started.
- **Each step is told its role.** The node's task names the squad agent's file
  by its full path and what the step receives: the request, or the result of
  the steps it requires. A step runs on the OpenBot agent that carries the
  squad agent's name when there is one, and on the agent that asked otherwise.
- **The agent is told when to run it.** OpenBot does not list workflows in an
  agent's context, so a workflow nobody mentions is never used. `--created`
  writes a marked section in the agent's instruction file
  (`<!-- nirvana-os:flows:v1 -->`) with one line per workflow. The owner's text
  around it is kept.
- **The squad stays the source.** The record keeps a revision of the workflow
  file and its agents' files; `--list` says when the squad changed since, and
  running the plan again gives the new `ops`.

Seen live on 2026-11-25 (OpenBot 0.78.0, an agent on the ChatGPT provider):
asked in Portuguese to "see the squad running as a workflow here", the agent
ran the three commands and built a six-node workflow in 82 s. Its run did the
three steps in about 65 s and stopped at the approval. A step that runs on the
agent that started the run waits in that agent's queue until its turn ends, so
the section tells the agent not to wait for the run in the same turn.

Not covered: a workflow's result does not pass the engine's quality gate (the
approval node is the check), a squad whose workflow has no `steps` cannot be
drawn, and no other host has an adapter for this.

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
