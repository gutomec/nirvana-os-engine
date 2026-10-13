<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: entra una frase, sale trabajo terminado. Workflows de agentes en paralelo convergen a través de quality gates." width="100%">

# Nirvana-OS

**Operaciones agénticas listas para ejecutar.** Entra una frase. Sale trabajo terminado.

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS / Linux**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[Documentación](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Instalación ilustrada](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**Léelo en tu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## Tú hablas con tu agente. Tu agente ejecuta Nirvana.

Ya trabajas con un agente de terminal: Claude Code, Codex, Antigravity, Pi, Grok u otro. Un prompt da una buena respuesta. El trabajo real necesita un investigador, un redactor, un revisor y un operador, con un registro de quién hizo qué.

Nirvana-OS le da esa organización a tu agente. Pides en lenguaje simple, y el agente usa Nirvana para elegir las empresas, squads y mind-clones adecuados, despacharlos, revisar lo que vuelve y mostrarte el comprobante. No aprendes una interfaz nueva ni escribes comandos en el día a día. Los comandos de más abajo son la referencia que usa tu agente, y están ahí para ti cuando los quieras.

## Qué es

Nirvana-OS es un sistema multiagente nativo en Bun y agnóstico de runtime. Funciona encima del agente que ya usas y nunca lo reemplaza. Trabaja con tres tipos de contenido, todos ellos carpetas en tu máquina:

| Pilar | Qué es | Dónde vive |
|---|---|---|
| **Empresas (businesses)** | Organizaciones con un organigrama. Una empresa despachada se ejecuta como un solo agente que ocupa sus puestos, usa squads a través de sus fichas y canaliza mind-clones | `~/businesses/` |
| **Squads** | Equipos de agentes portátiles con agentes, tasks y workflows que el agente despachado sigue como su método | `~/squads/` |
| **Mind-clones** | DNA de persona en cinco capas, para que un agente piense y escriba con el método de un experto concreto | `~/businesses/_library/dna/` |

El motor viene sin contenido. Creas empresas, squads y clones pidiéndoselo a tu agente, o instalas un pack de [squads.sh](https://squads.sh/pt/packs).

## Instalación

Ejecuta el comando de una línea del principio de esta página. Necesita `curl` (o `wget`) y `tar`, que macOS, Linux y Windows 10+ ya traen. No hace falta Node. Si falta [Bun](https://bun.sh), el instalador lo pone en tu carpeta de usuario (`~/.bun`) sin sudo y sigue adelante.

Lo que cambia en tu máquina:

- el motor en `~/.nirvana/skills`;
- la skill `nirvana` enlazada en cada runtime de agente que encuentra: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` y `~/.agents/skills` (OpenClaw);
- `nrv` y `nrv-hermes` en `~/.local/bin`, más una línea de PATH en el perfil de tu shell (el PATH del usuario en Windows);
- hooks de auditoría en Claude Code, Antigravity y Codex;
- las carpetas de contenido vacías `~/squads`, `~/businesses` y `~/businesses/_library/dna`.

Volver a ejecutarlo es seguro. Después abre una terminal nueva para que `nrv` esté en tu PATH, y pídele a tu agente: *"Comprueba que Nirvana-OS está bien instalado."* Ejecuta `nrv doctor`. La salida 1 significa solo avisos; la salida 2 lista lo que falló.

El comando de una línea no hace preguntas. Para elegir un perfil de rendimiento al instalar, pásalo así: `curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash -s -- --profile=balanced`. También puedes fijarlo más tarde pidiéndoselo a tu agente (ver [Configuración](#configuración)).

Las otras vías (la skill `nirvana` a través de skills.sh, la instalación desde un clon) están en [INSTALL.md](./INSTALL.md).

## Empieza un proyecto

Abre la carpeta en la que quieres trabajar, inicia ahí tu agente y di: *"Configura esta carpeta como un proyecto de Nirvana-OS."* El agente ejecuta `nrv init .`, que escribe `.nirvana/project.yaml` y una nota breve en `AGENTS.md`, `CLAUDE.md` y `GEMINI.md`. Los entregables quedan en `outputs/` dentro del proyecto.

Esa nota mantiene a tu agente trabajando como siempre. Usa Nirvana solo cuando tu pedido lo requiere:

- lo nombras ("usa Nirvana para…", "vía nirvana");
- nombras o señalas una de tus empresas, squads o mind-clones ("mi empresa de lanzamientos", "el squad de copy", "con la voz de Hormozi"), incluido el nombre de un pack;
- pides que el trabajo, o parte de él, corra en otro runtime ("usa Codex para revisarlo").

Si quieres que Nirvana orqueste cada entregable de un proyecto, di *"orquesta todo en este proyecto con Nirvana"*. El agente ejecuta `nrv init . --orchestrators=always`. Abre una sesión nueva para que el cambio surta efecto.

## Qué pedirle a tu agente

| Tú dices | Tu agente ejecuta |
|---|---|
| "¿Qué empresas / squads / mind-clones tengo?" | `nrv list-businesses`, `nrv list-squads`, `nrv list-clones` |
| "Usa Nirvana para escribir el copy de lanzamiento de X." | el harness: elige la empresa, escribe un brief, `nrv dispatch … --exec` |
| "Pasa esto por el squad de copy, en Codex." | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| "Detén esa ejecución." | `nrv run-track stop <run>` |
| "Cambia el titular de lo que entregaste." | `nrv revise <project> "<change>"` |
| "Muéstrame qué hizo esa ejecución." | `nrv audit-view <project>` |
| "Instala las dependencias de todos mis squads." | `nrv activate --all` |
| "Actualiza Nirvana-OS." | `nrv update` |
| "Actualiza mi pack Genesis Circle." | `nrv update genesis-circle` |
| "Pon Nirvana en modo economía." | `nrv config set execution.profile economy --global` |

Los pedidos más grandes funcionan igual:

```text
Usa Nirvana-OS para crear una empresa llamada podcast-empire que produzca, publique
y monetice 3 podcasts a la vez. Cada programa tiene su propio nicho, un presentador
de IA, un calendario editorial y un embudo de monetización independiente. Unos 7 empleados.
```

```text
Usa Nirvana-OS para convertir la obra pública de <author> en un mind-clone de IA completo.
```

```text
Usa Nirvana-OS para producir un paquete de lanzamiento: investigación de mercado,
copy de landing page y un análisis competitivo a fondo.
```

El agente orquesta y nunca escribe el entregable por sí mismo. Cada empresa que elige recibe su propio brief y su propia ejecución, en paralelo cuando las partes son independientes.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="Entra una orden en prosa, y un conglomerado de IA entero se arma y entrega" width="100%">
</div>

## Packs

Los packs son empresas, squads y mind-clones curados que se venden en [squads.sh](https://squads.sh/pt/packs). El buque insignia es [Genesis Circle](https://squads.sh/pt/nirvana-os).

1. Compra el pack en squads.sh y descarga su zip desde tu panel.
2. Descomprime el archivo entero en una carpeta, abre una terminal ahí y ejecuta el setup:
   - macOS / Linux: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   El setup instala Bun si hace falta, instala o actualiza el motor, copia el contenido en `~/squads`, `~/businesses` y `~/businesses/_library/dna`, reconstruye los índices y guarda la licencia del pack en `~/.nirvana-license/packs/<pack>/`.
3. Habla con tu agente: *"Usa Nirvana para listar lo que me dio el pack Genesis Circle"*, y luego pide trabajo nombrando una empresa, un squad o el pack.

Las dependencias de un squad se instalan bajo demanda la primera vez que el squad se ejecuta. Para prepararlas todas de antemano, pídele a tu agente que instale las dependencias de cada squad (`nrv activate --all`).

**Actualizar un pack.** Pídele a tu agente que lo actualice, o ejecuta `nrv update <pack>`. Los componentes que editaste se respaldan en `~/.nirvana/backups/packs/<pack>/` antes de que la actualización los reemplace. Si la actualización falla con un error de licencia, descarga el pack otra vez desde squads.sh y vuelve a ejecutar su setup; eso también renueva la licencia.

## Actualizar el motor

Pídele a tu agente que actualice Nirvana-OS, o ejecuta `nrv update`. Primero respalda `~/.nirvana/skills` y conserva tu configuración y tu contenido. `nrv update --check` nombra la versión que instalaría sin cambiar nada.

Una actualización nunca lleva el motor a una versión más antigua. Un motor estable pasa solo a un estable más nuevo. Una beta pasa a la versión mayor más reciente, beta o estable, así que una beta 0.15 se convierte en 0.15.0 cuando esta salga. Tras actualizar el motor, `nrv update` también revisa cada pack instalado que tenga licencia y avisa cuando alguno tiene una versión más nueva.

## Betas

Las betas son prereleases de GitHub. El comando de una línea instala el último estable, así que una beta se instala fijando su tarball:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz bash
```

```powershell
$env:NIRVANA_ENGINE_URL = "https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz"
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
Remove-Item Env:NIRVANA_ENGINE_URL
```

Reemplaza `<version>` por la versión, por ejemplo `0.15.0-beta.6`. El tag empieza con `v`; sin ella la descarga devuelve 404. La lista de versiones está en [GitHub](https://github.com/gutomec/nirvana-os-engine/releases). En PowerShell la variable vive durante toda la ventana, y por eso la última línea la elimina: mientras está definida, `nrv update` reinstala el tarball fijado.

Una vez en una beta, `nrv update` y el setup de cada pack te mantienen en el canal beta. Para volver al estable, ejecuta el comando de una línea normal del principio de esta página: instala el último estable encima de la beta, y tu contenido y tu configuración se quedan.

## Configuración

La configuración cambia cuando lo pides. Basta con *"pon Nirvana en modo economía"*, *"calidad máxima"* o *"¿qué está configurado?"*; tu agente ejecuta `nrv config` y te dice qué cambió.

Un perfil mueve varios ajustes a la vez:

| Perfil | Esfuerzo | Techo de contexto por worker | Revisión | Verificaciones visuales de los workers |
|---|---|---|---|---|
| `max` | xhigh | ninguno (predeterminado del runtime) | cada entrega, hasta dos rondas | activadas |
| `balanced` | high | 400k tokens | cuando una regla lo pide | desactivadas |
| `economy` | medium | 200k tokens | solo a pedido | desactivadas |

Un perfil nunca elige el modelo; eso lo hace la configuración propia de tu runtime. Un ajuste que cambias de forma explícita prevalece sobre el perfil. `nrv config list` muestra cada ajuste, su valor y de dónde viene. La referencia completa está en [docs/configuration.md](./docs/configuration.md).

## Por qué "el trabajo está hecho" significa algo aquí

Un orquestador puede anunciar cualquier cosa en su mensaje final. Nirvana-OS respalda cada entrega con cosas que puedes abrir en el disco.

- **Rastro de auditoría.** Cada despacho, veredicto del gate y entrega es un evento append-only en `~/.harness-logs/<date>/audit.jsonl`. Cada ejecución con `--exec` también deja un registro en el `.nirvana/run-kernel.sqlite` del proyecto. `nrv audit-view <project>` muestra la cadena.
- **Verificado en el disco.** `verify-deliverable` compara lo que el brief prometió con los archivos que existen, y el quality gate ejecuta rúbricas por tipo de archivo, con rondas de corrección cuando falla. Una ejecución cuyos fallos graves sobreviven a las correcciones se retiene, no se entrega.
- **Briefs con criterios.** Cada brief lleva el pedido del usuario al pie de la letra y criterios observables de "hecho cuando"; los marcados `(blocking)` deciden si la entrega pasa.
- **Gasto bajo tu control.** No se fija ningún techo de costo a menos que pidas uno (*"limita cada ejecución a US$ 5"* fija `budget.default_max_cost_usd`).

## Referencia de comandos

Para agentes y usuarios avanzados. `nrv help` lo lista todo; `nrv <command> --help` da las opciones de cada comando. Referencia completa: [docs/CLI.md](./docs/CLI.md).

| Comando | Qué hace |
|---|---|
| `nrv doctor` | Chequeo de salud: runtimes, hooks, enlaces de skills, dependencias, registros, licencias |
| `nrv init <dir>` | Convierte una carpeta en un proyecto Nirvana (`--orchestrators=always`, `--scope=project\|merge\|global`) |
| `nrv list-businesses` / `list-squads` / `list-clones` | Recorre los tres registros |
| `nrv find "<need>"` / `nrv search "<topic>"` | Candidatos ordenados para un pedido / búsqueda por palabra clave en las bibliotecas |
| `nrv brief template\|check\|decide` | El brief de seis secciones que el orquestador escribe para una empresa |
| `nrv dispatch <business> --brief-file <file> --exec` | Ejecuta una empresa sobre un brief; `--squad <slug>[:<capability>]`, `--agent-x` o `--auto` nombran otros objetivos. Se niega sin `--exec` |
| `nrv run-track status\|stop <run>` | Lee el estado de una ejecución, o la detiene limpiamente |
| `nrv revise <project> "<change>"` | Cambia una entrega en la misma sesión del runtime |
| `nrv audit-view <project>` | La cadena de auditoría de una ejecución |
| `nrv activate <squad>\|--all` | Prepara de antemano el entorno de un squad en `~/.nirvana/envs/<squad>` |
| `nrv config list\|get\|set\|unset\|explain` | Configuración, con `--global` o `--project` |
| `nrv update [--check]` / `nrv update <pack>` | Actualiza el motor / un pack |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | Puerta de admisión de una entidad |
| `nrv glance` | Cockpit web (`--read-only` para solo explorar) |
| `nrv uninstall --engine` | Elimina el motor y conserva tu contenido |

## FAQ

**¿Necesito saber programar?** No. Describes resultados en lenguaje simple; tu agente ejecuta Nirvana, y las empresas y squads escriben, revisan y entregan.

**¿Reemplaza a mi agente?** No. Funciona encima de él. El trabajo despachado corre en el runtime de tu sesión a menos que nombres otro: Claude Code, Codex, Antigravity, Pi, Kimi, Grok, Qwen Code u OpenCode.

**¿Dónde vive mi trabajo?** En tu máquina: el contenido en `~/businesses`, `~/squads` y `~/businesses/_library/dna`, los entregables en el `outputs/` de cada proyecto. No hay ninguna nube de Nirvana en el circuito.

**¿Y si nada de mi biblioteca encaja?** El pedido se ejecuta igual, en `agent-x`, el generalista. También puedes pedirle a tu agente que cree la empresa o el squad que falta.

**¿Windows?** Nativo, a través de Bun. Sin WSL.

## Licencia, autoría y estado

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sin coautores.

Licencia: la Nirvana-OS Sustainable Use License (SUL) v1.0. El código fuente está publicado y es abiertamente legible, y el motor es gratis para usar. Es source-available, no una licencia open-source aprobada por la OSI, y ciertos usos comerciales requieren una licencia comercial aparte. Lee [LICENSE](./LICENSE) antes de confiar en cualquier resumen, incluido este.

Estado: beta (0.x, actualmente 0.15.0-beta.6). El motor funciona hoy y se instala en minutos. Espera que la superficie siga moviéndose hasta la 1.0.
