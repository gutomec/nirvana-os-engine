<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: entra una frase, sale trabajo terminado. Workflows de agentes en paralelo convergen a través de quality gates." width="100%">

# Nirvana-OS

**Operaciones agénticas listas para ejecutar.** Entra una frase. Sale trabajo terminado.

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS, Linux y WSL**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[Documentación](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Instalación ilustrada](https://gutomec.github.io/nirvana-os-engine/install.html) · [Beta](https://gutomec.github.io/nirvana-os-engine/beta.html) · [Changelog](./CHANGELOG.md)

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

Este README describe la beta de 0.15, `v0.15.0-beta.7`. El comando de una línea del principio de esta página instala la última release **estable** (0.14.11); para instalar esta beta, usa los comandos de [Betas](#betas). No hace falta Node. Si falta [Bun](https://bun.sh), cualquiera de los dos instaladores lo pone en tu carpeta de usuario (`~/.bun`) sin sudo ni permisos de administrador y sigue adelante.

Antes de ejecutarlo:

- **macOS:** nada que preparar.
- **Windows (PowerShell):** nada que preparar, y sin permisos de administrador.
- **Linux (Ubuntu):** `sudo apt update && sudo apt install -y curl unzip`.
- **Windows con WSL (Ubuntu):** ejecuta `wsl --install` en un PowerShell abierto como administrador, reinicia, abre la app Ubuntu y crea tu usuario de Linux. Después instala `curl` y `unzip` como en Linux y ejecuta el comando `bash` dentro de Ubuntu. Tu agente de IA (Claude Code, Codex, Antigravity) también tiene que instalarse dentro de Ubuntu, y tus proyectos van en `~`, no en `/mnt/c`, que es lento.

Lo que cambia en tu máquina:

- el motor en `~/.nirvana/skills`;
- la skill `nirvana` enlazada en cada runtime de agente que encuentra: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` y `~/.agents/skills` (OpenClaw);
- `nrv` y `nrv-hermes` en `~/.local/bin`, más una línea de PATH en el perfil de tu shell (el PATH del usuario en Windows);
- hooks de auditoría en Claude Code, Antigravity y Codex;
- las carpetas de contenido vacías `~/squads`, `~/businesses` y `~/businesses/_library/dna`.

Volver a ejecutarlo es seguro. **Cierra la terminal y abre una nueva** para que `nrv` esté en tu PATH, y compruébalo con `nrv --version`; esta beta muestra `0.15.0-beta.7`. Después pídele a tu agente: *"Comprueba que Nirvana-OS está bien instalado."* Ejecuta `nrv doctor`. La salida 1 significa solo avisos; la salida 2 lista lo que falló.

Con `curl | bash` el instalador no hace preguntas. Para elegir un perfil de rendimiento al instalar, pásalo así: cambia el `bash` final por `bash -s -- --profile=balanced`. También puedes fijarlo más tarde pidiéndoselo a tu agente (ver [Configuración](#configuración)).

La guía paso a paso de cada sistema está en el [sitio de documentación](https://gutomec.github.io/nirvana-os-engine/install.html) (en portugués), con una [página para la beta](https://gutomec.github.io/nirvana-os-engine/beta.html), y en [INSTALL.md](./INSTALL.md), junto con las otras vías (la skill `nirvana` a través de skills.sh, instalar desde un clon).

## Empieza un proyecto

Abre la carpeta en la que quieres trabajar, inicia ahí tu agente y di: *"Configura esta carpeta como un proyecto de Nirvana-OS."* El agente ejecuta `nrv init .`, que escribe `.nirvana/project.yaml` y una nota breve en `AGENTS.md`, `CLAUDE.md` y `GEMINI.md`. Los entregables quedan en `outputs/` dentro del proyecto.

Esa nota mantiene a tu agente trabajando como siempre. Usa Nirvana solo cuando tu pedido lo requiere:

- lo nombras ("usa Nirvana para…", "vía nirvana");
- nombras o señalas una de tus empresas, squads o mind-clones ("mi empresa de lanzamientos", "el squad de copy", "con la voz de Hormozi"), incluido el nombre de un pack;
- pides que el trabajo, o parte de él, corra en otro runtime ("usa Codex para revisarlo").

Si quieres que Nirvana orqueste cada entregable de un proyecto, di *"orquesta todo en este proyecto con Nirvana"*. El agente ejecuta `nrv init . --orchestrators=always`. Abre una sesión nueva para que el cambio surta efecto. La estable 0.14.11 funciona al revés: el contrato completo es su valor predeterminado, y solo pregunta cuando tú mismo ejecutas `nrv init .` en una carpeta que ya tiene uno de esos archivos.

A partir de ahí hablas con tu agente en lenguaje natural y él usa Nirvana-OS. No escribes comandos en el día a día.

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
2. Descomprime el archivo completo y abre una terminal en la carpeta que contiene `setup.sh`:
   - macOS: haz doble clic en el zip, escribe `cd ` en Terminal, arrastra la carpeta a la ventana y pulsa Enter;
   - Windows: haz clic derecho en el zip, elige **Extraer todo**, abre la carpeta, haz clic derecho en un espacio vacío y elige **Abrir en Terminal**;
   - Linux y WSL: `cd ~/Downloads && unzip <archivo>.zip -d <carpeta> && cd <carpeta>`. En WSL, copia antes el zip de `/mnt/c/Users/<usuario>/Downloads` a `~/Downloads`.
3. Ejecuta el setup:
   - macOS, Linux y WSL: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   El setup instala Bun si hace falta, instala o actualiza el motor, copia el contenido en `~/squads`, `~/businesses` y `~/businesses/_library/dna`, reconstruye los índices y guarda la licencia del pack en `~/.nirvana-license/packs/<pack>/`. Nunca reemplaza el motor por una release más antigua, así que una beta sigue siendo beta.
4. Habla con tu agente: *"Usa Nirvana para listar lo que me dio el pack Genesis Circle"*, y luego pide trabajo nombrando una empresa, un squad o el pack.

**Activar los squads.** Las dependencias de un squad se instalan bajo demanda la primera vez que se ejecuta, en su propio entorno en `~/.nirvana/envs/<squad>`. Para prepararlas todas de antemano, pídele a tu agente: *"Activa todos mis squads de Nirvana."* Ejecuta `nrv activate --all`, que cubre paquetes de Node y Python, programas del sistema, claves de API y variables de entorno, servidores MCP y modelos. El agente recibe la lista de fallos con el comando exacto que corrige cada uno, y te pide permiso antes de cualquier cosa que use `brew`, `sudo` o `winget`, y para cualquier clave de API. La primera ejecución en un pack grande tarda varios minutos.

**Actualizar un pack.** Pídele a tu agente que lo actualice, o ejecuta `nrv update <slug-del-pack>`, por ejemplo `nrv update genesis-circle`. Los componentes que editaste se respaldan en `~/.nirvana/backups/packs/<pack>/` antes de que la actualización los reemplace. Si la actualización falla con un error de licencia, descarga el pack otra vez desde squads.sh y vuelve a ejecutar su setup; eso también renueva la licencia.

## Actualizar el motor

Pídele a tu agente que actualice Nirvana-OS, o ejecuta `nrv update`. Primero hace una copia de `~/.nirvana/skills` y conserva tu configuración y tu contenido. `nrv update --check` dice qué release instalaría sin cambiar nada.

Una actualización nunca lleva el motor a una release más antigua. Un motor estable solo pasa a una estable más nueva. Una beta pasa a la release mayor más nueva, beta o estable, así que una beta de 0.15 se convierte en 0.15.0 cuando esta salga. Después de actualizar el motor, `nrv update` también revisa cada pack instalado que tiene licencia y avisa cuando hay una versión nueva.

## Betas

Las betas son prereleases en GitHub, y este README es el de la beta: `v0.15.0-beta.7`. El comando del principio instala la última estable, así que la beta se instala fijando su tarball. La etiqueta empieza con `v`; sin ella la descarga devuelve 404. Para una beta más nueva, cambia esa etiqueta por una de la [lista de releases](https://github.com/gutomec/nirvana-os-engine/releases).

macOS, Linux y WSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.7/nirvana-os-engine.tar.gz bash
```

Windows (PowerShell), en una sola línea:

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.7/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

Después, si la ventana sigue abierta, ejecuta `Remove-Item Env:NIRVANA_ENGINE_URL`: mientras la variable exista, `nrv update` reinstala el tarball fijado. Los comandos de Windows usan comillas simples porque una comilla doble perdida al pegar deja a PowerShell esperando en `>>`.

Una vez en la beta, `nrv update` y cada setup de pack te mantienen en el canal beta: betas más nuevas y, cuando salga, la 0.15.0. Un proyecto preparado en 0.14.11 conserva su contrato completo hasta que ejecutas `nrv init .` en la beta, que lo cambia, en su sitio, por la nota bajo demanda (`--orchestrators=always` conserva el contrato completo); las líneas que escribiste encima del bloque de Nirvana se quedan.

**Volver a la estable.** En Windows, abre un PowerShell nuevo y ejecuta `Remove-Item Env:NIRVANA_ENGINE_URL`; un error que diga que no existe no es problema. Ejecuta el comando simple del principio de esta página. Instala la última estable sobre la beta y conserva tu contenido, los packs y la configuración. Comprueba que `nrv --version` ya no muestra `beta` y vuelve a ejecutar `nrv init .` en cada proyecto que usaste con la beta, después de quitar el bloque que la beta escribió en `AGENTS.md`, `CLAUDE.md` y `GEMINI.md` ([detalles](./INSTALL.md#back-to-stable-from-a-beta)).

## Configuración

La configuración cambia cuando lo pides. Basta con *"pon Nirvana en modo economía"*, *"calidad máxima"* o *"¿qué está configurado?"*; tu agente ejecuta `nrv config` y te dice qué cambió.

Un perfil mueve varios ajustes a la vez:

| Perfil | Esfuerzo | Techo de contexto por worker | Revisión | Verificaciones visuales de los workers |
|---|---|---|---|---|
| `max` | xhigh | ninguno (predeterminado del runtime) | cada entrega, hasta dos rondas | activadas |
| `balanced` | high | 400k tokens | cuando una regla lo pide | desactivadas |
| `economy` | medium | 200k tokens | solo a pedido | desactivadas |

Un perfil nunca elige el modelo; eso lo hace la configuración propia de tu runtime. Un ajuste que cambias de forma explícita prevalece sobre el perfil. `nrv config list` muestra cada ajuste, su valor y de dónde viene. La referencia completa está en [docs/configuration.md](./docs/configuration.md). Los perfiles existen solo a partir de 0.15.

**Por proyecto.** `nrv config set briefing.altitude <outcome|guided|prescriptive> --project` define cuánto lleva un brief: `outcome`, el predeterminado, dice el resultado, los límites y la definición de terminado; `guided` añade la estructura que sugiere el autor; `prescriptive` añade criterios por ítem, la lista de artefactos y el método. `nrv config get briefing.altitude` muestra el valor vigente. Las reglas en texto libre van en el `CLAUDE.md`, `AGENTS.md` o `GEMINI.md` del proyecto, encima del bloque de Nirvana que `nrv init` reescribe; tu agente las lee y las lleva a los briefs que escribe. Basta con pedirlo: *"en este proyecto, usa briefs guiados"*, *"añade al CLAUDE.md de este proyecto: todo entregable en portugués de Brasil"*.

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

**¿Windows?** Nativo, a través de Bun, sin necesidad de WSL. Si prefieres WSL, instala todo dentro de Ubuntu, tu agente incluido.

## Solución de problemas

- **PowerShell muestra `>>` y se queda esperando.** Quedó una comilla abierta al pegar. Pulsa Ctrl+C o abre una ventana nueva y vuelve a pegar la línea única.
- **macOS muestra "Saving session… [Processo concluído]" después de cerrar Terminal.** Es Terminal cerrando el shell, no un error.
- **La instalación devuelve 404.** A la etiqueta le falta la `v` inicial, o esa release no existe.
- **La actualización de un pack falla con un error de licencia.** Descarga el pack otra vez desde squads.sh y ejecuta su setup.
- **Cualquier otra cosa.** `nrv doctor` revisa toda la instalación y `nrv install --check` revisa los hooks y el PATH. Más en [INSTALL.md](./INSTALL.md#troubleshooting).

## Licencia, autoría y estado

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sin coautores.

Licencia: la Nirvana-OS Sustainable Use License (SUL) v1.0. El código fuente está publicado y es abiertamente legible, y el motor es gratis para usar. Es source-available, no una licencia open-source aprobada por la OSI, y ciertos usos comerciales requieren una licencia comercial aparte. Lee [LICENSE](./LICENSE) antes de confiar en cualquier resumen, incluido este.

Estado: beta (0.x, actualmente 0.15.0-beta.7). El motor funciona hoy y se instala en minutos. Espera que la superficie siga moviéndose hasta la 1.0.
