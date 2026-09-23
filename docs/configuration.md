# Your configuration, and what survives an update

Nirvana-OS reads settings from five places. Four of them belong to the engine,
a project or your shell. **One belongs to you and is never replaced:**

```
~/.nirvana/config.yaml
```

Everything the engine ships — including its own `skills/harness/config.yaml` —
is overwritten on every `nrv update`. A setting you put there is gone the next
time you update, and nothing tells you it left. The file above is the layer
that stays.

## The five layers

Strongest first. The first one that has a value wins.

| | Layer | Where | Survives `nrv update`? |
|---|---|---|---|
| 1 | Environment variable | your shell, a CI runner, a `.env` | n/a — it is set per run |
| 2 | Project | `<project>/.nirvana/config.yaml` | yes; it travels with the repository |
| 3 | **You** | `~/.nirvana/config.yaml` | **yes** |
| 4 | Engine | `skills/harness/config.yaml` | **no — replaced every update** |
| 5 | Schema default | in the code | n/a |

`NIRVANA_HOME` moves layer 3 with it, so a machine that relocates the Nirvana
home keeps its own settings there.

A variable always wins. That is deliberate: scripts, CI and the processes the
engine spawns need a way to pin a value that no file can override. `nrv config`
refuses to write a key a variable is currently pinning, and says which variable.

## What to do

You rarely need to open the file. The command writes it, validates the value
and keeps your comments:

```sh
nrv config list                                 # every key: effective value, where it came from, default
nrv config explain quality_gate.max_revisions   # what the key does, its scopes, its variable
nrv config set quality_gate.max_revisions 3 --global
nrv config unset quality_gate.max_revisions --global
```

Two keys deserve a word, because the obvious thing to set is the thing not to
set. `execution.model` and `execution.effort` are empty by design: a dispatch
names no model and no effort, so each CLI uses whatever its own configuration
says. Pinning them here overrides that for every run on this machine, including
runtimes where the value means nothing. Set them when you have a reason, not as
setup.

Inside a project, `set` and `unset` default to `--project`; outside one, to
`--global`. `--global` is always explicit about which file it means.

The file is born with a header that repeats this, so whoever opens it later —
you, a teammate, a support conversation — does not have to find this page
first. An existing file is never re-headed and never reformatted: writes are
line-by-line and your comments stay.

## When something looks wrong

```sh
nrv doctor
```

Its `CONFIG` section names your file, says whether it has anything in it, and
what to run. An empty or absent file is not a fault — it means every setting is
still at its default, which is the normal state of a fresh install.

To see *why* a value is what it is rather than where it should go:

```sh
nrv config list
```

The `origin` column distinguishes a variable in your shell from the project
file, your file, the engine file and the schema default. Most surprises are a
variable somebody exported, and that column is where they become visible.

## What is not here

Paths (`NIRVANA_HOME`, `SQUADS_DIR`, `BUSINESSES_DIR`, `DNA_LIBRARY`), library
scope (`NIRVANA_SCOPE`) and locale have their own contract and live in the
project's `.env` — see `docs/architecture/configuration.md` for the reasons and
for the complete key table. Credentials never live in a config file.

---

- Every key, its variable, default and scope: [`docs/architecture/configuration.md`](architecture/configuration.md)
- The commands themselves: [`docs/CLI.md`](CLI.md)
