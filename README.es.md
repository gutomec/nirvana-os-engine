<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: entra una frase, sale trabajo terminado. Workflows de agentes en paralelo convergen a través de quality gates." width="100%">

# Nirvana-OS

**Operaciones agénticas listas para ejecutar.** Entra una frase. Sale trabajo terminado.

[![npm downloads](https://img.shields.io/npm/dm/@nirvana-os/cli)](https://www.npmjs.com/package/@nirvana-os/cli)
[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@nirvana-os/cli?label=npm)](https://www.npmjs.com/package/@nirvana-os/cli)

```bash
npx @nirvana-os/cli
```

Un solo comando instala el motor y lo enlaza con cada agente de terminal que encuentra. Es seguro volver a ejecutarlo en cualquier momento.

[Documentación](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Instalación ilustrada](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**Léelo en tu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## Tu agente es afilado. También está solo.

Ya ejecutas un agente de terminal: Claude Code, Codex, Gemini-CLI o Antigravity. Un prompt da una buena respuesta. El trabajo real no es un prompt. Es un investigador, un redactor, un revisor y un operador tirando en la misma dirección, en paralelo, con un registro de cada paso. Hoy, el pegamento eres tú.

Nirvana-OS asciende a ese agente solitario a maestro que dirige organizaciones enteras. Describes el resultado en prosa simple. El motor lee el brief, consulta lo que tienes, despacha empresas, squads y mind-clones en paralelo, reconcilia todo detrás de un quality gate y escribe un rastro de auditoría de cada despacho. Dejas de ser el operador y pasas a ser el director.

Toda la interfaz es prosa más un comprobante. Tú hablas. Tu agente ejecuta los comandos.

## Qué es

Nirvana-OS es un sistema operativo multiagente nativo en Bun y agnóstico de runtime. Crea, gestiona y administra un conglomerado: cualquier número de empresas y squads, orquestado desde el brief hasta el entregable verificado. Es la capa de orquestación por encima de tu agente de terminal, no un reemplazo.

El valor predeterminado es **cero humanos**: las empresas funcionan de forma autónoma, y la intervención humana es opt-in mediante disparadores explícitos en el manifiesto. Tú enuncias el resultado. El motor elige el elenco.

Todo lo que crea es una de tres cosas:

| Pilar | Qué es | Dónde vive |
|---|---|---|
| **Empresas (businesses)** | Organizaciones autónomas con un organigrama de empleados persistentes que llaman a squads | `~/businesses/` |
| **Squads** | Equipos de agentes portátiles que ejecutan workflows reales: DAG, quality gates, escalación | `~/squads/` |
| **Mind-clones** | DNA de persona en 5 capas, inyectado en los empleados para que piensen y hablen con el método de un maestro | `~/businesses/_library/dna/` |

Una empresa orquesta empleados. Un empleado llama a squads. Un squad ejecuta agentes. Un mind-clone le da a cualquiera de ellos una voz más verdadera. Un solo brief puede movilizar a muchos de ellos a la vez.

## Inicio rápido

Lo que necesitas: [Bun](https://bun.sh) 1.0 o más reciente. Node 18+ y `tar` existen solo para que `npx` funcione, y la mayoría de las máquinas ya los tienen.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL
npx @nirvana-os/cli

# Windows (nativo, sin WSL), en PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
# abre una NUEVA ventana de PowerShell para que el PATH se actualice
npx @nirvana-os/cli
```

El instalador coloca un único árbol de skills en `~/.nirvana/skills`, lo enlaza con `~/.claude`, `~/.codex`, `~/.gemini` y `~/.antigravity` donde los encuentre, y pone los binarios `nrv` en tu PATH. Instala el motor y ningún contenido: tus registros empiezan vacíos por diseño, así que todo lo que hay en ellos es algo que construiste o elegiste instalar. Volver a ejecutar el instalador es idempotente y siempre descarga el motor más reciente.

Confirma que la instalación está sana:

```bash
nrv doctor
```

En Windows, `nrv doctor` también revisa en el PATH del usuario las entradas temporales `nrv-*` que los motores hasta la 0.8.0 podían dejar atrás. `nrv install --repair-path` las lista sin escribir nada; `--apply` elimina exactamente esas y mantiene todas las demás tal como están.

Luego abre tu agente y di **"usa Nirvana-OS para…"**. Para una configuración dirigida por el agente, apunta tu runtime a [`AGENT-QUICKSTART.md`](./AGENT-QUICKSTART.md).

## Demo de 90 segundos

> **Espacio reservado.** El recorrido canónico de 90 segundos se incrusta aquí en cuanto se publique. Hasta entonces, esta es la vista en vivo de una orden en prosa armando un conglomerado.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="Entra una orden en prosa, y un conglomerado de IA entero se arma y entrega" width="100%">
</div>

<!-- DEMO-90s SLOT
     Canonical 90-second demo goes here when published (trace 75fbfbcc, phase X3).
     Replace the block above with:
     <a href="VIDEO_URL"><img src="THUMBNAIL_URL" alt="Nirvana-OS en 90 segundos" width="100%"></a>
-->

## Míralo funcionar: todo es una frase

**Construye una empresa describiéndola.** El sistema diseña la organización, escribe a cada empleado, cablea los workflows y valida el resultado contra el Business Protocol.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

**Clona a un experto en prosa.** La fábrica de genios extrae un DNA de 5 capas (filosofías, modelos mentales, heurísticas, frameworks, metodologías) de la obra pública de una persona, con cada elemento citado de vuelta a su fuente.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

**Una frase, muchos equipos a la vez.** Un solo brief puede convocar un squad de investigación, un squad de copy y una empresa de diseño en paralelo, reconciliados detrás de un único quality gate, con el rastro de auditoría mostrando cada elección que hizo el maestro.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

Más flujos, incluido "diseña la agencia, clona a los especialistas, constrúyela" en tres preguntas, están en la [página principal de la documentación](https://gutomec.github.io/nirvana-os-engine/), que ejecuta la misma frase en los siete runtimes soportados: Claude Code, Codex, Gemini, Antigravity, Grok, Kimi y Hermes.

## Por qué "el trabajo está hecho" significa algo aquí

Los sistemas multiagente tienen un problema de confianza: un orquestador puede anunciar cualquier cosa en su mensaje final. Nirvana-OS responde con tres garantías, cada una respaldada por un mecanismo que puedes abrir en el disco.

- **Rastreable.** Cada acción se convierte en un evento append-only en `~/.harness-logs/<date>/audit.jsonl`: brief recibido, despacho, mind-clone inyectado, gate aprobado o reprobado. Cada ejecución con `--exec`, en modo `standard` o a través del Gauntlet, también deja un Run canónico en el `.nirvana/run-kernel.sqlite` del proyecto, un journal append-only que Glance lee. Sin estos eventos, ningún mensaje de finalización es honesto.
- **Probado.** `verify-deliverable.ts` compara lo que el brief prometió con lo que realmente existe en el disco. `quality-gate.ts` ejecuta rúbricas por tipo de archivo en un bucle de juzgar, criticar y revisar. Sin un PASS del verify, no hay finalización legítima.
- **Contratado.** Las tasks tienen criterios de aceptación binarios. Las capabilities tienen inputs y outputs tipados. El output destinado al cliente pasa por una cadena de aprobación: productor, luego revisor, luego aprobador. Los presupuestos son un techo rígido, y los disparadores de escalación definen exactamente cuándo un humano entra en el bucle.

## Motor gratis, contenido de pago

El motor de este repositorio es gratis, sin un tier recortado y sin nada básico bajo llave. Crea y orquesta empresas, squads y mind-clones desde cero. El código fuente está publicado y es abiertamente legible bajo la [Sustainable Use License](./LICENSE) (source-available, no aprobada por la OSI; ciertos usos comerciales requieren una licencia aparte).

La capa de pago es **contenido, no capacidad**: colecciones curadas y listas para ejecutar, entregadas a través de [squads.sh](https://squads.sh). La diferencia que los packs te compran es tiempo, no poder. Explóralos en **[squads.sh/pt/packs](https://squads.sh/pt/packs)**. El buque insignia, **[Genesis Circle](https://squads.sh/pt/nirvana-os)**, entrega un conglomerado completo que puedes ejecutar desde el primer día, mantenido al día con `nrv update <pack>`.

| | Motor gratis (este repo) | Packs ([squads.sh/pt/packs](https://squads.sh/pt/packs)) |
|---|---|---|
| Crear desde cero | Sí | Sí |
| Orquestar en paralelo | Sí | Sí |
| Rastro de auditoría en cada despacho | Sí | Sí |
| Squads, empresas y mind-clones preconstruidos | Ninguno, vacío por diseño | Un conglomerado completo, desde el primer día |

## El puñado de comandos que vale la pena escribir tú mismo

| Tú escribes | Qué hace |
|---|---|
| `npx @nirvana-os/cli` | Instala o actualiza el motor (idempotente) |
| `nrv glance` | Cockpit web: empresas, squads, clones, auditoría, costos. En un proyecto adoptado, un Message del chat ejecuta un despacho real en un proceso hijo, con línea de tiempo en vivo, cancelación y recuperación tras un reinicio. `--read-only` lo mantiene en solo lectura |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | Recorre los tres registros |
| `nrv search "<topic>"` | Encuentra capabilities en los tres registros |
| `nrv dispatch --business <slug> \| --squad <slug> \| --agent-x "<brief>" --exec` | Ejecuta un brief contra un objetivo que tú nombras; el router nunca se consulta |
| `nrv run <business> "<brief>" --execution-mode=gauntlet --gauntlet-intensity=light\|balanced\|exhaustive` | Opta por el Gauntlet: candidatos, evaluaciones y rondas de revisión en tres intensidades (los objetivos Business necesitan `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST`) |
| `nrv multi-target plan\|run\|status <plan.json>` | Compila, ejecuta o inspecciona un plan multi-target sobre el Run Kernel (`NIRVANA_MULTI_TARGET_KILL_SWITCH=1` desactiva `run`) |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | Puerta de admisión de una entidad, o `--all` para todas las instaladas; `--fix` repara lo que se puede reparar sin inventar nada |
| `nrv migrate <slug> --to 6 [--apply]` | Convierte un squad al Squad Protocol 6.0; dry run por defecto, `--apply` escribe con copia de seguridad |
| `nrv update <pack>` | Actualiza un pack instalado |
| `nrv doctor` | Revisa la instalación; en Windows, `nrv install --repair-path` limpia las entradas del PATH del usuario sobre las que avisa |

Todo lo demás lo ejecuta tu agente. Referencia completa: [docs/CLI.md](./docs/CLI.md).

## FAQ

**¿Necesito saber programar?** No. Describes resultados en lenguaje simple; el sistema escribe, valida y ejecuta el código.

**¿Reemplaza a mi agente?** No. Funciona encima de Claude Code, Codex, Gemini-CLI o Antigravity, y hace que el que ya tienes orqueste a muchos.

**¿Dónde vive mi trabajo?** En tu máquina, bajo `~/businesses`, `~/squads` y `~/businesses/_library/dna`. Local-first, sin ninguna nube de terceros en el circuito.

**¿Y si el sistema no puede hacer lo que pido?** Lo dice. Un brief que no coincide con nada recibe un rechazo más una sugerencia de crear la capability que falta. Un brief ambiguo recibe una pregunta de vuelta, con los mejores candidatos.

**¿Windows?** Nativo, a través de Bun. Sin necesidad de WSL.

## Licencia, autoría y estado

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sin coautores.

Licencia: la Nirvana-OS Sustainable Use License (SUL) v1.0. El código fuente está publicado y es abiertamente legible, y el motor es gratis para usar. Es source-available, no una licencia open-source aprobada por la OSI, y ciertos usos comerciales requieren una licencia comercial aparte. Lee [LICENSE](./LICENSE) antes de confiar en cualquier resumen, incluido este.

Estado: beta (0.x, actualmente 0.12.4). El motor funciona hoy y se instala en minutos. Espera que la superficie siga moviéndose hasta la 1.0.
