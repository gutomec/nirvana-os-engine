# Adapter · OpenClaw

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v2.
> Identidade + capabilities do sistema: ver `../NIRVANA-OS.md` (fonte única).
> Pesquisado em 2026-08-13 contra `docs.openclaw.ai` e `openclaw/openclaw` no GitHub.

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| Runtime | OpenClaw (`openclaw`) |
| Skills spec | [AgentSkills](https://agentskills.io) — `SKILL.md` com frontmatter YAML |
| Skills roots (precedência) | `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `<state-dir>/skills` → bundled |
| Onde o engine instala | `~/.agents/skills` (personal), via `RUNTIME_SKILL_DIRS` |
| Descoberta | varre até 6 níveis, casa pelo campo `name` do frontmatter — **não** pelo nome da pasta |
| Invocação | `/harness` (slash), `$harness` (referência no prompt), ou dispatch direto por tool |
| Contrato de projeto | **não existe** equivalente a `CLAUDE.md` / `AGENTS.md` lido pelo runtime |
| Subagente in-process | **não existe** |
| Delegação | `bash background:true` → CLI filho; acompanhamento por `process poll` / `process log` |

---

## 1.1 Fresh install — the ~/.agents trap (fixed in 0.7.4)

A machine where OpenClaw was just installed via npm has the `openclaw` binary
on PATH but NO `~/.agents` yet — the directory is created on first run. Engine
installers before 0.7.4 gated linking on the directory existing, so the skills
link was silently skipped: no error, no `~/.agents/skills`, and the buyer
concluded the product was broken. Since 0.7.4 the installer probes the binary
too and creates the directory itself; `nrv doctor` reports a `skills link:
openclaw` line either way. On an older engine, the workaround order is:

    npm i -g openclaw@latest
    mkdir -p ~/.agents        # or `openclaw setup`, which creates it
    bun scripts/install.ts    # now links

Remember the two facts the runtime cannot teach (also printed by the
installer): OpenClaw reads no project contract — invoke explicitly with
`/harness <brief>` — and has no in-process subagent, so the scripted path
(`nrv dispatch --exec`) is the real dispatch.

---

## 2. A diferença que decide tudo

Claude Code, Codex e Antigravity têm um primitivo de subagente que roda dentro
da sessão e devolve o resultado. O OpenClaw **não tem**. O que ele tem é o mesmo
padrão que a própria skill `coding-agent` dele usa:

```
bash background:true workdir:<dir> command:"claude --permission-mode bypassPermissions --print < $PROMPT"
```

Isso devolve um **session id** na hora. O acompanhamento é por `process poll`
(status) e `process log` (saída). E a conclusão **não chega sozinha**: o worker é
instruído a anunciar o próprio fim com

```
openclaw message send --channel <channel> --target '<target>' --message '<resultado breve>'
```

Três consequências para o Nirvana, e nenhuma é opcional:

1. **O caminho de dispatch aqui é o SCRIPTADO**, não o agêntico in-process.
   `nrv dispatch --exec` (que é `runHeadless` disparando um CLI filho) é
   exatamente a forma que o OpenClaw já usa. O `Agent(...)` do harness §Phase 4
   não existe neste runtime.
2. **A garantia de "nunca esquecido" passa a depender do ledger**, não de uma
   notificação do runtime. É precisamente o cenário para o qual o run-ledger e o
   supervisor foram construídos: sem callback automático, a prova de vida é a
   atividade em disco sob `--outputs`, o lease vence, e o supervisor escala e
   avisa. Ver `harness/SKILL.md` §Run ledger & supervisor.
3. **O contrato de invocação não pode morar num arquivo de projeto**, porque o
   OpenClaw não lê nenhum. Ele mora na skill — que é justamente onde o Nirvana
   já o coloca desde 2026-08-13. Um projeto sem `nrv init` aqui não é degradação
   parcial: é o único modo que existe.

---

## 3. Concept Mapping

| Conceito Nirvana | OpenClaw |
|---|---|
| Skill (harness/squads/businesses) | `SKILL.md` em `~/.agents/skills/<nome>/` |
| Invocar o maestro | `/harness` ou `$harness` no prompt |
| Dispatch para business/squad | `bash background:true` → `nrv dispatch --exec --target <slug>` |
| Retorno do alvo | `process poll` até terminar + `_SUMMARY.md` em disco |
| Notificação de fim | worker anuncia via `openclaw message send`, ou o supervisor do Nirvana avisa |
| Quality gate | idêntico — `quality-gate.ts`, roda no shell |
| Auditoria | idêntica — `~/.harness-logs/<data>/audit.jsonl` |
| Mind-clone | idêntico — DNA injetado no prompt do CLI filho |

---

## 4. Frontmatter

O OpenClaw exige `name` + `description` e aceita `metadata.openclaw` para
gating. O bloco abaixo é o que faz a skill aparecer só onde ela funciona — sem
ele, um usuário sem Bun vê a skill, invoca e recebe erro:

```yaml
metadata:
  openclaw:
    emoji: "🎼"
    requires:
      bins: ["bun"]        # todo script do Nirvana é Bun-nativo; sem bun nada roda
      anyBins: ["claude", "codex", "opencode"]   # algum CLI para receber o dispatch
```

`user-invocable` fica no default (`true`), então `/harness` funciona.
Não usar `disable-model-invocation`: o harness precisa ativar por descrição
quando o usuário pede um artefato sem citar o sistema pelo nome.

---

## 5. Dispatch — a forma correta neste runtime

```bash
# 1. prep (idêntico a todo runtime): abre o run no ledger, emite auditoria
bun ~/.nirvana/skills/squads/scripts/brief-squad.ts <slug> "<brief>" --project <trace_id>

# 2. dispatch em background, com o CLI filho que o OpenClaw tiver
bash background:true workdir:<project_dir> \
  command:"nrv dispatch '<brief>' --target squad:<slug> --project <trace_id> --exec"

# 3. acompanhar SEM varrer o disco
process poll <session_id>

# 4. quando terminar: gate, fechar o run, avisar
bun ~/.nirvana/skills/harness/scripts/quality-gate.ts <artefato> --auto
nrv run-track close <run-id> --state delivered|withheld|failed
```

As regras do harness que **valem igual aqui**: recibo não é resultado (aqui o
recibo é o session id); nunca inferir conclusão varrendo arquivo — use
`process poll`, que é a resposta autoritativa; dispatch não leva timeout; e uma
onda de alvos independentes dispara todos os `bash background:true` antes de
esperar qualquer um.

---

## 6. Limites conhecidos

- **Sem contrato de projeto.** Não há `CLAUDE.md`/`AGENTS.md` que o OpenClaw
  leia, então a ativação depende inteiramente da descrição da skill. Escrever a
  descrição bem é aqui uma questão de funcionamento, não de estilo.
- **Conclusão é anunciada, não entregue.** Se o worker morrer antes de anunciar,
  quem percebe é o supervisor do Nirvana pelo lease vencido — não o OpenClaw.
- **`~/.agents/skills` é compartilhado.** Outras ferramentas escrevem ali (o CLI
  do `agentskills`, por exemplo). O engine linka por-skill, nunca o diretório
  inteiro: um symlink do diretório para a árvore de outro runtime faz cada skill
  ser alcançável duas vezes e gera "Skill conflict detected".
