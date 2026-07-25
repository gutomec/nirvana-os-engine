# Changelog

All notable changes to the Nirvana-OS engine. Versions map to GitHub releases
(`nirvana-os-engine`); each release ships the full engine tarball that
`npx @nirvana-os/cli` and pack installs consume.

## 0.1.63 — 2026-07-25

### Colisão de slug agora é avisada (não mais silenciosa)
- Política inalterada: o pack é a fonte da verdade dos SEUS componentes, vence
  sempre e não há backup — quem altera o que é nosso é responsável pelas
  próprias mudanças. O que muda é só a VISIBILIDADE: se o usuário criou um
  componente com o mesmo slug de um do pack, o sync o sobrescrevia em silêncio e
  o trabalho dele sumia sem explicação (virava issue "sumiu do nada").
- Detecção exata: existe em disco E não está no manifesto do pack
  (`~/.nirvana-pack.json`) ⇒ é criação do usuário. Sem falso positivo na segunda
  rodada, quando o pack já passou a ser dono do slug.
- Reportado como `N overwritten` na contagem e em bloco próprio no fim, com o
  caminho de saída (renomear o seu) e o que foi preservado (run-state:
  `projects/`, `outputs/`, `memory/projects`). Aplicado nos DOIS caminhos de
  sync — `scripts/install.ts` (starter) e `_shared/scripts/install-content.ts`
  (o que o comprador roda via `setup.ts` do pack e `nrv update <slug>`).

### Clones em layout legado aninhado voltam a ser indexados
- Instalações de pack em ≤ 0.1.61 gravaram `dna/<categoria>/<slug>/` (issue #2,
  corrigida na 0.1.62). Quem já tinha essa árvore continuava com `0 mind-clones
  indexed` mesmo após atualizar, porque o scanner só via um nível.
- `index-clones.ts` agora lê os dois layouts: leitor liberal, escritor estrito.
  NADA é movido em disco — mexer nos dados do usuário durante um comando de
  leitura seria pior que o bug. O writer já é flat desde a 0.1.62, então este é
  um caminho de compatibilidade que decai sozinho conforme as instalações
  antigas reinstalam.
- Flat vence no empate de slug; para o clone aninhado a categoria vem do próprio
  diretório-pai. O total legado é reportado ao fim do index, com a orientação de
  que reinstalar o pack normaliza e nada precisa ser movido à mão.

## 0.1.62 — 2026-07-25

### Bibliotecas de conteúdo criadas vazias no install (`~/squads`, `~/businesses`, `~/businesses/_library/dna`)
- O engine é core-only (não embarca conteúdo), mas os diretórios onde o usuário
  cria as SUAS empresas/squads/mind-clones não existiam após a instalação: o
  `scripts/install.ts` só os criava quando havia conteúdo do starter pack para
  copiar (`if (available.length > 0) mkdirSync(dstRoot)`). Com `--no-starter`
  (o caminho do `npx`), nenhum era criado — e o comportamento ainda era
  inconsistente: `~/squads` acabava surgindo por acaso no primeiro `nrv index`
  (via `squads/lib/registry.js`), enquanto `~/businesses` e a biblioteca de DNA
  nunca apareciam. Resultado: instalação nova reportava `⚠ 3 warning(s). System
  usable but degraded.` no `nrv doctor`.
- Agora `ensureContentLibraries()` cria os três VAZIOS, antes do starter pack
  (vale com e sem `--no-starter`). Espelha o que o escopo de projeto já fazia
  (`init-project.ts` cria `.nirvana/{squads,businesses,mind-clones}`).
- NÃO destrutivo e idempotente: `mkdir` recursivo é no-op em diretório
  existente — conteúdo do usuário é preservado (reporta `kept` em vez de
  `created`). Cross-OS: só `path.join` + `mkdirSync`, sem comando de shell, com
  EEXIST tolerado (o Bun lança no Windows mesmo com `recursive: true`).
  `nrv install --check` continua sem mutar nada.

### Fix: pack install gravava mind-clones aninhados por categoria (issue #2) — 0 clones indexados
- `installer.ts` instalava clone em `dna/<categoria>/<slug>/`, mas o layout
  canônico é FLAT (`dna/<slug>/`) — o que `index-clones.ts` (varre um nível só)
  e `install-content.ts` já seguiam. Todo pack com mind-clones instalado por
  `nrv install --type=pack` resultava em `0 mind-clones indexed`.
- Instala flat agora (pack e asset avulso) e grava a categoria como METADADO em
  `.pack-categories.json` — arquivo que o indexer lê mas que NENHUM fluxo do
  engine escrevia, então `pack_category` nunca saía de `null`.
- Colisão de slug dentro do pack agora falha explícita (antes ficava mascarada
  por categorias diferentes). Inferência de categoria endurecida: packs reais
  são flat, então o nome do diretório pai gravaria `"mind-clones"` como
  categoria. `index-clones.ts` passou a resolver o mapa por-root (o metadado
  gravado em escopo de projeto era ignorado).

### Fix: `nrv init --with-skills` quebrava com cópia de 312 MB e projeto pela metade (issue #3)
- Eram três defeitos encadeados, não um: (1) o branch de symlink não criava
  `<target>/.agents`, então `symlinkSync` falhava com ENOENT; (2) caía no
  fallback de cópia; (3) `copyTree` usava `statSync` e seguia o symlink
  `node_modules` de cada skill → centenas de MB e recursão infinita nos ciclos
  de `node_modules/.bin/*` (ELOOP). Corrigir só o `copyTree` deixaria o gatilho
  de pé, com todo `--with-skills` copiando em vez de linkar.
- `copyTree` usa `lstatSync`, pula `node_modules` em QUALQUER profundidade (não
  só no topo) e recria symlinks em vez de expandi-los; `.agents` passou a ser
  criado no branch de symlink; e a falha de cópia virou fail-closed — antes era
  `log.warn` e o comando saía 0 deixando um projeto quebrado.

### Fix: `nrv index` falhava no Windows em escopo de projeto (issue #1, bug 2)
- `businesses/lib/registry.ts` fazia `mkdirSync` cru; no Bun/Windows isso lança
  EEXIST mesmo com `recursive: true` quando o diretório já existe — o caso de
  `<projeto>/.nirvana`, que existe desde o `nrv init`. Passou a usar o helper
  canônico `ensureDir`, que já tolera EEXIST. (Os outros 3 bugs da issue #1 já
  estavam corrigidos desde a 0.1.25/0.1.26.)

### grok-cli: flag documentada + custo real
- Trocado `--yolo` por `--always-approve` (código e docs). `--yolo` funciona,
  mas é alias OCULTO — não aparece no `--help` e pode sumir entre builds.
- O driver gravava `costUsd: null` fixo alegando que a assinatura não reporta
  gasto; o build real devolve `total_cost_usd` no JSON. Agora é parseado.
- Invocação VERIFICADA contra o binário real (`grok 0.2.103`): flags aceitas,
  JSON com `text`/`sessionId`/`total_cost_usd`. O `kimi-cli` segue NÃO
  verificado (binário ausente na máquina de teste).

## 0.1.61 — 2026-07-20

### Novos runtimes first-class: Kimi Code CLI + Grok Build CLI
- `kimi-cli` (Moonshot, binário `kimi`) e `grok-cli` (xAI, binário `grok`) agora são
  runtimes de primeira classe, iguais a codex/gemini-cli/antigravity-cli: `runKimi`/
  `runGrok` no host-agent-driver, presentes em VALID_RUNTIMES/EXEC_RUNTIMES,
  RUNTIME_ALIASES (`USE_KIMI`/`USE_GROK`), detecção de host, menção no brief, glance,
  `.env.example`, e adapters completos em `_shared/adapters/{kimi-cli,grok-cli}.md` +
  `_shared/agents/agent-x.{kimi,grok}.md`. Model vem só do LLM_CASCADE
  (`kimi-cli:k3` / `grok-cli:<model>`), NUNCA hardcoded (model-agnostic).
  - Kimi: grátis via OAuth Kimi.com (K3/K2.7), `kimi -m <model> -p … --output-format stream-json`.
  - Grok: coding agêntico + geração de mídia nativa, `grok -p … --output-format json --yolo --cwd`.
  - Ressalva: as invocações ainda NÃO foram verificadas contra os binários `kimi`/`grok`
    reais (fallback seguro se uma flag divergir).

### Consolidação dos adapters em `_shared/adapters/` (v5, fonte única)
- Aposentada a camada `squads/adapters/` v4.0 (duplicatas/órfãs): removidos codex,
  gemini-cli, antigravity, cursor, claude-code. As tabelas de `squads/references/*`
  agora apontam para `_shared/adapters/`. Nenhum código dependia da camada v4.
- Antigravity: eliminado o adapter órfão (id `antigravity`/binário `antigravity`/modelo
  fixo); fica só o canônico `antigravity-cli` (binário `agy`, sem model).
- Cursor: removido (substituído pelo `grok-cli`).
- Purgados TODOS os nomes de modelo velhos dos adapters — o engine usa o default do
  runtime ou o escolhido pelo usuário, nunca um id fixo.

## 0.1.60 — 2026-07-18

### Fix: validator drift — v5 capability/business description caps
- `capability-validator.js` (the v5 structural pre-check that `validate-squad.ts`
  runs) hard-coded the capability `description` cap at 500, which had drifted from
  the raised canonical limit (1500 in `_shared/validators/limits.ts`, the same
  `LIMITS` the zod validators use). Valid v5 manifests with 500–1500-char
  capability descriptions were wrongly rejected, aborting `brief-squad.ts` prep
  (e.g. a squad's `whatsapp.system.provision` at 639 chars). It now reads the cap
  from `limits.ts` (single source of truth) with a safe fallback to 1500 — never
  500 again, so the fast pre-check can't drift from the authoritative validator.
- Aligned the JSON schemas to `limits.ts`: capability `description` 500→1500 and
  `example_briefs` items 500→1000; business `description` 500→2000 and
  `example_briefs` items 500→1000.

## 0.1.59 — 2026-07-17

### Windows: CRLF-tolerant parsing
- The frontmatter parsers were `\n`-anchored, so a Windows CRLF checkout made
  `---\r\n` fail to match → rubrics (and 8 other parsers: mind-clone/squad/
  business audit criteria, clone inspect/list/translate) silently loaded
  nothing, and the quality gate selected no rubric on Windows. Fixed with a
  `.gitattributes` (`eol=lf` for parsed files, `eol=crlf` for `.cmd` launchers)
  plus CRLF-tolerant regexes as defense in depth. Caught by the new quality-gate
  test on the Windows CI runner.

## 0.1.58 — 2026-07-17

### The engine never prescribes a model
- The model used is ALWAYS the one configured in the user's own agent runtime
  (Claude Code, Codex, Gemini, Antigravity, …). The engine only overrides it when
  the user explicitly asks for a specific model.
- Removed every default model from the engine: judge config (`default_judge_model:
  inherit`), capability `model_hint` default, rubric `target_model` (now
  telemetry-only `inherit`), adapter docs, and the pixelle client (now
  `gemini-flash-latest`, the provider's non-versioned pointer — no more 404s from
  retired model slugs).

### Router: explicit mention wins; business-first stops hijacking
- New Stage 0.5: naming a squad or business by slug ("use o squad code-review…")
  deterministically short-circuits routing (`route_tier: explicit_mention`) —
  before any scoring. Accent/hyphen-normalized, guarded against false positives.
- Business-first preference is now a relative tiebreak against the best squad,
  never an absolute floor; artifact-pattern routes (`business_route`) compete
  inside the RRF fusion as a third ranked list instead of short-circuiting ahead
  of content matching. Briefs that clearly match a squad no longer get hijacked
  by unrelated business routes.

### Repo & docs
- `CHANGELOG.md` (this file), `AGENT-QUICKSTART.md` (one-page agent onboarding),
  `SECURITY.md`, issue/PR templates, `examples/` end-to-end walkthrough.
- README hero image + CI badge; version badge now rewritten from `package.json`
  at publish time.
- `AGENTS.md` is the single source for the agent contract; `CLAUDE.md`/`GEMINI.md`
  are generated copies (drift fails the publish).
- `skills/harness/SKILL.md` normalized to English throughout.
- New tests: audit event emission (`audit-emit`) and quality-gate selection/fail-closed paths.

## 0.1.57 — 2026-07-13

- **Windows:** `nrv index` fixed (POSIX-only bun-path check made every indexer
  spawn fail with ENOENT when Bun wasn't on PATH); shell-string quoting replaced
  by argv-based `run()`; 11 `.cmd` wrappers fixed (`>nul` instead of
  `/dev/null`); spawn errors now surface their cause.
- **Install anywhere:** the npx installer auto-installs the latest Bun on Windows
  (PowerShell) and continues in the same run; `nrv` is added to the user PATH via
  registry + `WM_SETTINGCHANGE` broadcast so new terminals work without a
  restart; post-install indexing now runs on Windows (`nrv.cmd`); hook commands
  are quoted and use per-OS stderr suppression; `fileURLToPath` fixes repo-root
  resolution on Windows.

## 0.1.56 — 2026-07-13

- Grok-aware ENGINE-MENU (Grok Imagine i2v across video squads' guidance).
- `brief-squad.ts`: squad dispatch now scaffolds the project dir, HANDOFF and
  brief AND emits `brief_received`/`dispatch_squad` automatically — the audit
  trail exists on any runtime, no reliance on the agent obeying SKILL.md.

## 0.1.55 — 2026-07-10

- `nrv doctor` reports honestly: "last activity <date>" instead of a false
  "no dispatches yet?"; detects outputs-without-audit (agent not emitting
  events) and squad dispatches (not only businesses); OS-safe paths.

## 0.1.54 — 2026-07-10

- Security hardening: removed `js-yaml` (DoS advisory GHSA-h67p-54hq-rp68) —
  the two remaining users migrated to `yaml` v2; `bun audit` clean.
- Embedder locked with `allowLocalModels=false` (closes the local-model vector
  of the ONNX CVEs; hub/cache behavior unchanged).

## 0.1.53 — 2026-07-10

- Hybrid retrieval: BM25 + optional local dense arm (transformers.js/ONNX,
  multilingual MiniLM) fused with Reciprocal Rank Fusion; opt-in via
  `nrv embeddings enable` — the core stays zero-hard-dep with graceful fallback.
- Router calibration (E1–E7 external audit): capability `keywords`/
  `example_briefs`/`produces` indexed with field weighting; org-noun vs verb
  separation; best-business-only promotion; generic-object abstention in the
  keyword stage; meta-intent pruning.
- Retroactive learning loop: audit readers accept `business_slug`/`squad_name`
  aliases (history recovered); `nrv audit emit` canonical writer CLI.
- First router test suite (69 tests) + YAML/HTML validation rubrics.

---

Earlier releases (0.1.9 → 0.1.52) predate this changelog; see the GitHub
release notes of each tag for their summaries.
