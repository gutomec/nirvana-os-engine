# @nirvana-os/cli

Instalador do **Nirvana-OS** — o sistema operacional para trabalho agêntico, local-first e agnóstico de runtime.

```bash
npx @nirvana-os/cli
```

## Como funciona

Este pacote é um **launcher fino**: ele não carrega o engine. Ao rodar, baixa o **engine mais recente do GitHub** (o asset do último release de [`gutomec/nirvana-os-engine`](https://github.com/gutomec/nirvana-os-engine)) e o instala. Atualizações do engine saem publicando um release no GitHub — este pacote npm é publicado uma vez e praticamente nunca de novo.

## O que instala

Apenas o **motor de criação** — tudo para criar do zero:

- **squads** (Squad Protocol v5): protocolo, templates, schema, wizard de criação, validator
- **businesses** (Business Protocol v1): protocolo, templates, schema
- **mind-clones**: ferramentas de criação, validação, indexação e tradução
- **harness**: dispatch, roteamento, cockpit (`nrv glance`), CLI `nrv`

Não acompanha conteúdo pronto. Os squads, businesses e mind-clones curados são **packs pagos** (Genesis Circle e futuros), instalados por cima via https://squads.sh.

## Runtimes suportados

Uma única árvore em `~/.nirvana/skills` é consumida por todos os runtimes detectados na máquina:

| Runtime | Como é ligado |
|---|---|
| Claude Code | symlinks em `~/.claude/skills` + audit hooks |
| Codex | symlinks em `~/.codex/skills` (auditoria via transcripts — Codex não tem hooks granulares) |
| Gemini-CLI | symlinks em `~/.gemini/skills` + audit hooks |
| Antigravity (`agy`) | symlinks em `~/.antigravity/skills` + audit hooks |
| Hermes | ponte via `external_dirs` no `~/.hermes/config.yaml` (opt-in) |

Runtimes não instalados são pulados. Rode de novo a qualquer momento (idempotente).

## Requisitos

- **Bun** (≥ 1.0) — o instalador oferece instalar se faltar
- Node ≥ 18 e `tar` (Win10+, macOS, Linux já têm) — só para o `npx` baixar e extrair o engine

## Depois de instalar

```bash
nrv install --check     # verifica os hooks em todos os runtimes
nrv validate            # smoke-test dos registries
nrv glance              # abre o cockpit
nrv init ~/meu-projeto  # bootstrap de um novo projeto
```

## Overrides (testes / fork / offline)

```bash
NIRVANA_ENGINE_TARBALL=/caminho/engine.tar.gz   # usa um engine local, sem rede
NIRVANA_ENGINE_REPO=owner/repo                   # default: gutomec/nirvana-os
NIRVANA_ENGINE_URL=https://.../engine.tar.gz     # override da URL
```

## Licença

Nirvana-OS Sustainable Use License (SUL). Ver `LICENSE`.

Autor: Luiz Gustavo Vieira Rodrigues (Prospecteezy) — https://github.com/gutomec
