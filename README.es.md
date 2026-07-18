# Nirvana-OS engine

[![version](https://img.shields.io/badge/version-0.1.60--beta-blue)](#licencia-autoría-y-estado)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**Léelo en tu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## Comanda un universo de empresas en lenguaje natural

Ya tienes un agente de terminal. Claude Code, Codex, Gemini-CLI o Antigravity. Es afilado, y está solo.

Nirvana-OS convierte a ese único agente en un maestro que opera **empresas enteras**. Describes lo que quieres en prosa simple, y el sistema levanta las organizaciones, los equipos especialistas y las mentes expertas para entregarlo, muchas de ellas a la vez, con un comprobante de cada paso.

```bash
npx @nirvana-os/cli
```

Un solo comando. Instala el motor, se enlaza a cada runtime de agente que encuentra, y es seguro ejecutarlo de nuevo en cualquier momento. Nada más que configurar.

Y aquí está la regla que esta página no deja de comprobar, sección tras sección: **tú hablas, tu agente ejecuta los comandos.** El puñado que vale la pena teclear por tu cuenta cabe en una sola tabla corta.

## No necesitas otro chatbot. Necesitas una organización que haga el trabajo.

Un único agente responde un prompt. El trabajo real no es un prompt. Es un investigador, un redactor, un revisor y un operador tirando en direcciones distintas, coordinados, con un rastro documental. Hoy el pegamento eres tú: ejecutas prompt tras prompt a mano y coses las piezas tú mismo, sin registro de quién hizo qué.

Nirvana-OS te saca del pegamento. Enuncias el resultado en prosa. El motor lo lee, consulta lo que tienes, despacha la combinación correcta de empresas y squads, los ejecuta en paralelo, reconcilia el resultado detrás de un quality gate, y anota cada despacho. Pasas de operador a director: enuncias el objetivo e inspeccionas el resultado.

## Para quién es esto

Un público pequeño y específico, a propósito: desarrolladores y operadores que ya usan un agente de terminal y han notado que el cuello de botella se movió. Una buena respuesta ahora es fácil. El trabajo coordinado que vale por toda una organización, con prueba de quién hizo qué, sigue siendo difícil, y ese es el problema que este motor elimina. Nirvana-OS no reemplaza a tu agente. Lo asciende.

## Qué es, en un respiro

Nirvana-OS es un sistema operativo multiagente nativo de Bun que crea, gestiona y administra un conglomerado: cualquier número de empresas y/o squads, orquestados desde el brief hasta el entregable verificado. Es la capa de orquestación **por encima** de tu agente de terminal, no "una empresa que construye empresas", y trabaja con tres materiales, todos moldeados por lenguaje natural:

- **Empresas (businesses):** organizaciones autónomas con un organigrama de empleados. Cada empleado llama a squads. Viven en `~/businesses/`.
- **Squads:** equipos portátiles de agentes que ejecutan workflows reales (DAG, gates, escalación) y entregan resultados terminados. Viven en `~/squads/`.
- **Mind-clones:** DNA de persona en 5 capas, inyectado en los empleados para que piensen y hablen con el método de un maestro. Viven en `~/businesses/_library/dna/`.

Una sola solicitud puede movilizar a muchos de ellos al mismo tiempo. El orquestador (el `harness`) elige el elenco. Tú solo describes el resultado.

## Míralo funcionar: todo es una frase

Esta es la parte que importa. No escribes código, no llenas formularios, no editas config. Le hablas al sistema, dentro del runtime de IA que ya usas, nombrándolo: **"usa Nirvana-OS para…"**. Así se ve.

### 1. Construye una empresa describiéndola

Dale la jerarquía y los roles en prosa. Diseña la organización, escribe a cada empleado, cablea los workflows y valida el resultado.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

El sistema ejecuta su fábrica de empresas: lectura de intención, investigación de dominio, un plano organizacional que tú apruebas, y luego empleados, memoria y workflows, validados contra el Business Protocol. Terminas con `~/businesses/podcast-empire/`, con personal y listo para operar.

### 2. O deja que el sistema diseñe la empresa por ti

¿Aún no sabes cuál es la estructura correcta? Pregunta. Este es el flujo del que la mayoría se enamora.

**Paso uno, pide el diseño:**

```text
Use Nirvana-OS: how would a complete, modern marketing agency be structured?
Give me the hierarchy, the key roles, and who the best specialists in the world
are for each seat.
```

El sistema responde con un organigrama real: un director creativo, un jefe de performance, un director de copy, un líder de contenido, un estratega, y los nombres de los operadores cuyos métodos debería encarnar cada puesto.

**Paso dos, clona a esos especialistas:**

```text
Great. Clone those specialists into mind-clones I can hire.
```

Ejecuta la fábrica de mind-clones y produce DNA de persona para cada uno, el pensamiento, las heurísticas y la voz de ese tipo de operador.

**Paso tres, construye la empresa con ellos en los puestos:**

```text
Now build the agency, and put those clones in the matching roles as the
brains of each employee.
```

Ensambla la empresa, asigna cada mind-clone al empleado correcto, y crea cualquier squad especialista que la agencia necesite pero aún no tenga. Hiciste tres preguntas en español simple y obtuviste una empresa con personal.

### 3. Crea un squad especialista en prosa

Cuando una empresa necesita una capacidad que ningún equipo existente cubre, describe el equipo que quieres.

```text
Use Nirvana-OS to generate a squad for headless e-commerce automation, with
agents for catalog, checkout, inventory, and support. Validate it against the
Squad Protocol.
```

Sale `~/squads/…/` con agentes, tasks, workflows, schemas, una configuración de harness y un README, todo validado.

### 4. Clona a un experto en prosa

Convierte la obra pública de cualquiera en un asesor que tus empleados pueden usar.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

La fábrica extrae un DNA de 5 capas (filosofías, modelos mentales, heurísticas, frameworks, metodologías), construye la persona, la somete a un panel de otras mentes, y entrega un asesor que puedes soltar en cualquier empresa.

### 5. Una frase, muchos equipos a la vez

El orquestador está encantado de movilizar varias empresas y squads a partir de un solo brief.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

Esa sola línea puede convocar un squad de investigación, un squad de copy y una empresa de diseño en paralelo, cada uno con empleados que cargan los mind-clones correctos, reconciliados detrás de un único quality gate. Tú no elegiste a ninguno de ellos. El maestro lo hizo, y el rastro de auditoría muestra sus elecciones.

> Toda la interfaz es prosa más un comprobante. Sin llamadas a API, sin archivos de config. Describe el resultado, y luego lee el rastro de auditoría que prueba lo que pasó.

Lo que deja una pregunta práctica. ¿Cómo le dices todo esto a *tu* agente? Instala primero; eso toma un minuto.

## Instala en 60 segundos

La misma idea en cada sistema operativo: instala Bun una vez, luego ejecuta un comando.

Lo que necesitas: Bun 1.0 o más nuevo ejecuta todo. Node 18 o más nuevo y `tar` existen solo para que `npx` funcione; la mayoría de las máquinas ya los tienen. Python 3.10 o más nuevo es opcional, necesario solo para `nrv export --pdf` y `--zip`.

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # reload PATH, or just open a new terminal
npx @nirvana-os/cli        # installs the engine
```

### Windows (nativo, sin WSL)

Todo el sistema corre sobre Bun, así que Windows solo necesita Bun. En **PowerShell**:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# open a NEW PowerShell window so PATH refreshes
npx @nirvana-os/cli
```

### Qué hace realmente el instalador

Coloca un único árbol de skills en `~/.nirvana/skills`, lo enlaza a `~/.claude`, `~/.codex`, `~/.gemini` y `~/.antigravity` dondequiera que los encuentre, y pone los binarios `nrv`, `nrv-gemini` y `nrv-hermes` en `~/.local/bin` (`%USERPROFILE%\.local\bin` en Windows), en tu PATH automáticamente. Instala el motor y ningún contenido. Volver a ejecutar `npx @nirvana-os/cli` es idempotente y siempre trae el motor más reciente.

Para confirmar que la instalación está sana:

```bash
nrv doctor
```

Luego abre tu agente y di **"usa Nirvana-OS para…"**. La siguiente sección muestra exactamente cómo se ve eso en cada runtime.

## Cómo pedírselo a tu agente, runtime por runtime

No hay una app de Nirvana-OS que abrir. Le hablas al agente que ya usas, y una frase despierta al sistema: **"usa Nirvana-OS para…"**. También sirven variantes: "vía Nirvana", "orquesta con Nirvana", "usa mis empresas", "usa mis squads". La frase dispara el skill `harness`. Ese skill es el maestro.

| Runtime | Estado del enlace | Cómo lo pides |
|---|---|---|
| Claude Code | Siempre enlazado | Prosa, en tu chat. El agente invoca el harness por sí mismo. |
| Codex | Enlazado si está presente | Igual: prosa, en proceso. |
| Antigravity (`agy`) | Enlazado si está presente | Igual: prosa, en proceso. |
| Hermes | Puente opt-in | `hermes chat`, luego prosa. O one-shot con `hermes -z`. |
| Gemini-CLI | Enlazado si está presente | Subproceso vía `nrv dispatch` (legacy, en retirada). |

En detalle:

- **Claude Code, Codex, Antigravity (en proceso):** escribes la frase y nada más. El agente invoca `Skill("harness", "<your brief>")` por sí mismo, o activa el skill al coincidir con su descripción. Nunca sales de la conversación.
- **Hermes:** ejecuta `hermes chat` y pregunta en prosa. Para un one-shot, `hermes -z "use the nirvana-os skill: <brief>"`. El puente llama a `nrv dispatch` por ti.
- **Gemini-CLI (legacy):** el motor lo maneja como subproceso a través de `nrv dispatch`. Funciona, y está en vías de salir.
- **Cualquier directorio de proyecto:** ejecuta `nrv init <dir>` una vez. Escribe un contrato `AGENTS.md`, con copias `CLAUDE.md` y `GEMINI.md` idénticas byte a byte, para que cualquier agente que abra el directorio descubra el harness por su cuenta.

### El sistema sugiere. Tú decides.

No necesitas memorizar lo que tienes instalado. En modo agéntico, el predeterminado, el maestro razona sobre los tres registros: empresas, squads, mind-clones. Una coincidencia limpia se despacha. Un brief ambiguo recibe una pregunta de vuelta, con los mejores candidatos y sus descripciones, para que elijas con contexto. Ninguna coincidencia en absoluto recibe un rechazo más una sugerencia de crear la capacidad que falta, nunca un intento falso.

La selección de mind-clone sigue un orden fijo: solicitado, luego asignado, luego búsqueda, luego predeterminado. Y cada vez que el sistema elige un clon, también te muestra los candidatos alternativos que dejó pasar.

Lo que plantea la siguiente pregunta obvia: ¿razona sobre *qué*, exactamente? Míralo tú mismo.

## Echa un vistazo con `nrv`

Los comandos de descubrimiento son de solo lectura y seguros en cualquier momento.

```bash
nrv glance            # read-only web cockpit: companies, squads, clones, audit, costs
nrv list-businesses   # organizations registered locally
nrv list-squads       # the agent teams
nrv list-clones       # persona DNA available to inject
nrv search "launch"   # find capabilities across all three registries
```

Ejecuta esto en una instalación recién hecha y te topas con la primera objeción honesta a todo este discurso: todo vuelve vacío.

Bien. Eso es el diseño, no un defecto. La fábrica está instalada; la carga no. El motor se entrega con pleno poder para crear y orquestar y con cero contenido preconstruido, así que todo lo que hay en esos registros es algo que tú construiste o elegiste instalar. Nada llega que tú no hayas puesto ahí.

Entonces, ¿qué va en los registros? Tres tipos de cosa, y solo tres.

## Los tres pilares

Todo lo que el motor crea y orquesta es una de tres cosas. Este es el modelo mental completo.

| Pilar | Qué es | Dónde vive |
|---|---|---|
| **Empresas** | Organizaciones autónomas, cada una con un organigrama de empleados | `~/businesses/` |
| **Squads** | Equipos de agentes portátiles que ejecutan workflows (DAG, gates, escalación) | `~/squads/` |
| **Mind-clones** | DNA de persona inyectado en empleados para voz y juicio | `~/businesses/_library/dna/` |

Una empresa orquesta empleados. Un empleado llama a squads. Un squad ejecuta agentes. Un mind-clone le da a cualquiera de ellos una voz más verdadera. Un solo brief rara vez necesita solo uno.

Eso es lo que son. Cómo se forma cada uno es donde se ve la ingeniería.

## Anatomía: cómo se forma cada pilar

La prosa es la interfaz, pero nada por debajo es vago. Cada pilar es un paquete con un protocolo detrás, y la anatomía vale dos minutos de tu tiempo.

### Cómo se forma un squad (Squad Protocol v5)

Un squad es un paquete portátil bajo `squad.yaml`, construido a partir de exactamente cuatro tipos de partes:

- **Agentes:** cada persona es un archivo `.md` con dos audiencias dentro. El frontmatter YAML carga la configuración de runtime y lo lee la máquina; el cuerpo en prosa es el system prompt y lo lee el modelo.
- **Tasks:** la unidad de trabajo. Una task declara entradas, pasos, salidas y criterios de aceptación que son binarios y verificables: pasó o no pasó. Las tasks no tienen dueño.
- **Workflows:** YAML que enlaza agentes a tasks en un DAG. Los pasos en el mismo nivel forman una ola paralela. Cuando un runtime no puede generar subagentes, el workflow degrada con gracia a ejecución secuencial.
- **Capabilities:** la capa de descubrimiento de v5. Cada capability tiene un id jerárquico con puntos (`domain.subdomain.verb`), una descripción, dominios, entradas y salidas tipadas, ejemplos, una lista `not_for`, y un contrato `invoke` que apunta a un workflow, una task o un agente.

La regla que lo sostiene todo: la capability es lo que el squad promete, atómica y vista desde afuera; el workflow es el cómo; la task es una unidad dentro.

### Cómo se forma una empresa (Business Protocol v1)

Una empresa es un paquete bajo `business.yaml`, y es la unidad de coherencia organizacional. Dentro:

- **Empleados:** agentes especialistas persistentes. Cada uno es un archivo `.md` cuyo frontmatter declara `role`, `reports_to`, un `type` (`functional_specialist` o `mind_clone`), y un `self_score_contract`; el cuerpo es el system prompt.
- **Un organigrama:** jerarquía real, no decoración. Junto a él: enrutamiento y procesos.
- **Memoria:** memoria permanente para la organización, más memoria aislada por proyecto.
- **Gobernanza:** presupuestos, disparadores de escalación, cadenas de aprobación, y un `culture.md`.

Un empleado no fabrica todo a mano. Antes de producir cualquier entregable atómico por sí mismo, pregunta "¿hay un squad para esto?", llama a uno o más squads (gobernado por una lista blanca `squads_authorized`; vacía significa todos permitidos), e integra el resultado de vuelta. El trabajo se mueve entre empleados a través de cinco primitivas de handoff: mención (`@name`), ticket, escalación (arriba), delegación (abajo) y auto-enrutamiento.

Una regla estructural tiene dientes: una empresa con más de 5 empleados necesita un antagonista, un puesto cuyo trabajo es contradecir.

### Cómo se forma un mind-clone (5 capas de DNA)

Un mind-clone es el método destilado de un experto real, extraído de su obra pública en 5 capas:

1. **L1 Filosofías:** creencias y axiomas.
2. **L2 Modelos mentales:** cómo el experto estructura problemas.
3. **L3 Heurísticas:** reglas tácticas rápidas.
4. **L4 Frameworks:** sistemas con nombre.
5. **L5 Metodologías:** procesos paso a paso.

Cada ítem carga una cita `^[FONTE:file:section:excerpt]` de vuelta al material fuente, y cada build reporta su cobertura de fuentes (94%, por ejemplo). El paquete es concreto: `MANIFEST.yaml`, más `agent/AGENT.md` (una emulación cognitiva en primera persona), `agent/SOUL.md` (valores, miedos, contradicciones, influencias), `agent/DNA-CONFIG.yaml`, y `dna/dna-schema.md` (las 5 capas con sus fuentes).

En runtime el DNA se inyecta entero en el prompt de un empleado, con una instrucción permanente: el clon está plenamente incorporado, así que entrega como si el clon hubiera producido el trabajo. La inyección nunca es silenciosa. Emite un evento de auditoría `mind_clone_injected` que registra bytes y sha256 de cada archivo inyectado, para que puedas probar qué mente estuvo en la sala. El catálogo contiene 503 clones, incluidos David Ogilvy, Alex Hormozi, Seth Godin y Dan Kennedy.

## Puedes hacer más de todo: las meta-herramientas

El motor trae tres fábricas, y se llaman entre sí. Así es como una empresa que pediste en una frase termina completa.

- **Business Creator** convierte un brief en prosa en una organización completa: empleados, memoria, workflows, validados de punta a punta. Cuando necesita una capacidad que ningún squad cubre, delega en el Squad Creator.
- **Squad Creator** convierte un brief en prosa en un squad validado: agentes, tasks, workflows, schemas, configuración de harness, README.
- **Genius Factory** convierte la obra pública de una persona en un mind-clone de 5 capas, y luego te entrega un asesor listo para contratar.

Meta-herramientas que llaman a meta-herramientas es la razón por la que "diseña la agencia, clona a los especialistas, constrúyela" funciona como tres frases simples.

## Cómo funciona

Dale un brief al harness y hace cinco cosas, en orden:

1. Lee el brief.
2. Consulta los tres registros: empresas, squads, mind-clones.
3. Despacha la mejor combinación, que pueden ser muchas empresas y/o squads en paralelo.
4. Reconcilia los resultados detrás de un quality gate.
5. Escribe un rastro de auditoría en `~/.harness-logs/<date>/audit.jsonl`.

```
                       brief
                         │
                         ▼
                ┌───────────────────┐
                │ harness (maestro) │
                │ read · route ·    │
                │ dispatch          │
                └───────────────────┘
                         │
        consults the three registries
       (companies · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  company A │   │  squad X   │    │  mind-clones │
 │ employees  │   │  workflow  │◀───│  injected as │
 │  → squads  │   │  DAG·gates │    │  persona DNA │
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └───── parallel dispatch ──────┘
                         │
                         ▼
                ┌───────────────────┐
                │   quality gate    │
                │ reconcile output  │
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
       final result        ~/.harness-logs/<date>/audit.jsonl
                            (every dispatch, on the record)
```

El paralelismo es la cuña: un brief puede poner a varios equipos a trabajar en la misma ejecución y reunir su salida al final. El rastro de auditoría es la confianza: abre el log y rastrea qué agentes corrieron, con qué brief, en qué orden, y por qué. El trabajo agéntico deja de ser una caja negra.

Un diagrama es una afirmación. Tres garantías la hacen cumplir.

## Los tres sellos: trazable, probado, contratado

Los sistemas multiagente tienen un problema de confianza. Un orquestador puede anunciar cualquier cosa en su mensaje final. Nirvana-OS responde con tres garantías, cada una respaldada por un mecanismo que puedes abrir en disco.

**Trazable.** Cada acción se convierte en un evento de solo anexado en `audit.jsonl`: `brief_received`, `dispatch_business`, `dispatch_squad`, `mind_clone_injected`, `gate_passed` o `gate_failed`, `verify_passed` o `verify_failed`. El log vive en `~/.harness-logs/<date>/audit.jsonl` y es visible en `nrv glance`. La regla es contundente: sin estos eventos, ningún mensaje de finalización es honesto. La interfaz es prosa más un comprobante.

**Probado.** Dos programas se interponen entre una afirmación y un entregable. `verify-deliverable.ts` compara la verdad del disco: lo que el brief prometió contra lo que existe de verdad en disco, marcando cualquier cosa faltante o simulada. `quality-gate.ts` ejecuta rúbricas por tipo de archivo, en un bucle de juzgar, criticar y revisar. Sin un verify en PASS no hay un `gate_passed` legítimo. Los squads también cargan un contrato de fidelidad con la verdad de referencia, y los empleados se autopuntúan antes de cada handoff.

**Contratado.** Nada se mueve por intuición. Las tasks tienen criterios de aceptación binarios. Las capabilities tienen entradas y salidas tipadas; el id es el contrato y la implementación permanece oculta. Los handoffs son artefactos estructurados de a lo sumo 800 tokens. La salida destinada al cliente pasa una cadena de aprobación: productor, luego revisor, luego aprobador. Los presupuestos son un techo duro, y los disparadores de escalación definen exactamente cuándo un humano debe entrar en el bucle.

Trazable te dice qué pasó. Probado te dice que es real. Contratado te dice que estaba permitido. Juntos son la razón por la que "el trabajo está hecho" significa algo aquí.

## Núcleo abierto: el motor es gratis, y sigue gratis

El motor en este repo es gratis, sin un nivel mutilado y sin nada básico bajo llave. Crea y orquesta empresas, squads y mind-clones desde cero. Si quieres construir tu propio conglomerado desde cero, el motor es todo lo que necesitarás y no debes nada.

Eso es deliberado. El motor es la capacidad completa, y regalar la capacidad completa es cómo se construye la confianza: puedes verificar todo en esta página antes de gastar nada.

Gratis invita a una pregunta justa: ¿es open-source? Seamos precisos aquí. El código fuente está publicado y es de lectura abierta, pero la licencia es source-available, no open-source aprobada por la OSI, y ciertos usos comerciales requieren una licencia comercial aparte. La [sección de licencia](#licencia-autoría-y-estado) lo detalla.

La capa de pago es **contenido, no capacidad**: colecciones curadas y listas para ejecutar de squads, empresas y mind-clones, entregadas a través de [squads.sh](https://squads.sh).

| | Motor gratis (este repo) | Packs de pago (squads.sh) |
|---|---|---|
| Crear desde cero | Sí | Sí |
| Orquestar en paralelo | Sí | Sí |
| Rastro de auditoría en cada despacho | Sí | Sí |
| Instalación multi-runtime | Sí | Sí |
| Squads, empresas, mind-clones preconstruidos | Ninguno, vacío por diseño | Un conglomerado completo, listo para ejecutar |
| Tiempo hasta un conglomerado funcional | Lo construyes tú | Día uno |

La diferencia que compran los packs es **tiempo, no poder**. El buque insignia, **Genesis Circle**, entrega 39 squads de producción, 11 empresas y 159 mind-clones en una sola instalación. Los packs se instalan sobre el motor y se mantienen al día con `nrv update <pack>`. [Ve los packs en squads.sh](https://squads.sh).

## Los comandos `nrv`: tu agente ejecuta la mayoría

La CLI existe para que los propios skills y hooks del sistema puedan manejar el motor, y para que tu agente pueda actuar en tu nombre. En el uso diario, tú hablas y tu agente teclea. El puñado genuinamente humano:

| Tú tecleas | Qué hace |
|---|---|
| `npx @nirvana-os/cli` | Instalar o actualizar el motor (idempotente) |
| `nrv glance` | Cockpit web de solo lectura: empresas, squads, clones, auditoría, costos |
| `nrv init <dir>` | Escribir el contrato `AGENTS.md` en un directorio de proyecto |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | Navegar los tres registros (solo lectura) |
| `nrv search "<topic>"` | Buscar capabilities en los tres registros |
| `nrv update <pack>` | Actualizar un pack instalado |
| `nrv doctor` | Verificar la instalación |

Todo lo demás lo ejecuta el agente o es avanzado. `Skill("harness", …)` es la entrada en proceso que tu agente usa. `nrv dispatch`, `nrv run` y `nrv auto` manejan la orquestación desde la shell. `nrv ask <clone>` habla con un solo mind-clone con su DNA inyectado; `nrv revise` aplica un cambio a un proyecto en la misma sesión de runtime; `nrv audit-view` recorre la cadena de auditoría de un proyecto; `nrv export` empaqueta la salida de un proyecto (Python 3.10+ solo necesario para `--pdf` y `--zip`).

Dos comandos merecen un aviso de degradación. `nrv route` y `nrv find` son diagnósticos BM25 con pérdida: bien para un olfateo rápido de palabras clave, nunca una fuente de verdad. El maestro agéntico es la fuente de verdad.

Referencia completa: [docs/CLI.md](./docs/CLI.md).

## FAQ

**¿Necesito saber programar?** No. Describes resultados en lenguaje natural. El sistema escribe, valida y ejecuta el código.

**¿Tengo que aprender la CLI?** No. Tu agente ejecuta la mayoría de los comandos `nrv` por ti. El puñado humano es la instalación, `nrv glance`, `nrv init`, el trío `list-*`, `nrv search`, `nrv update` y `nrv doctor`.

**¿Y si el sistema no puede hacer lo que le pido?** Lo dice. Cuando un brief no coincide con nada en tus registros, el maestro rechaza y sugiere crear la capacidad que falta. Cuando es ambiguo, pregunta, con los mejores candidatos y sus descripciones.

**¿Reemplaza a mi agente?** No. Corre sobre Claude Code, Codex, Gemini-CLI o Antigravity, y hace que el que tienes orqueste a muchos.

**¿Dónde vive mi trabajo?** En tu máquina, bajo `~/businesses`, `~/squads` y `~/businesses/_library/dna`. Local primero, sin ninguna nube de terceros en el bucle.

**¿El motor es realmente gratis?** Sí. Los packs de pago son contenido preconstruido que te ahorra tiempo. El motor construye las mismas cosas desde cero sin costo.

**¿Windows?** Nativo, a través de Bun. Sin WSL requerido.

## Licencia, autoría y estado

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sin coautores.

Licencia: la Nirvana-OS Sustainable Use License (SUL) v1.0. En términos claros, porque aquí es donde se gana o se pierde la confianza: el código fuente está publicado y es de lectura abierta, y el motor es gratis de usar. Es **source-available, no una licencia open-source aprobada por la OSI**, y ciertos usos comerciales requieren una licencia comercial aparte. Si esa distinción importa para tu caso, lee [LICENSE](./LICENSE) antes de confiar en cualquier resumen, incluido este.

Estado: beta (0.x, actualmente 0.1.59). El motor funciona hoy e instala en minutos. Espera que la superficie siga moviéndose hasta 1.0.
