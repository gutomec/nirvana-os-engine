# Motor Nirvana-OS

[![version](https://img.shields.io/badge/version-0.1.24--beta-blue)](#licencia-autoría-y-estado)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**Lee esto en tu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## Comanda un universo de empresas en lenguaje natural

Ya tienes un agente de terminal. Claude Code, Codex, Gemini-CLI o Antigravity. Es afilado, y está solo.

Nirvana-OS convierte ese único agente en un maestro que dirige **empresas enteras**. Describes lo que quieres en prosa, y el sistema levanta las organizaciones, los equipos especialistas y las mentes expertas para entregarlo, muchas de ellas a la vez, con un recibo de cada paso.

```bash
npx @nirvana-os/cli
```

Un comando. Instala el motor, se enlaza con cada runtime de agente que encuentra y es seguro de ejecutar otra vez cuando quieras. Nada más que configurar.

## No necesitas otro chatbot. Necesitas una organización que haga el trabajo.

Un solo agente responde a un prompt. El trabajo real no es un prompt. Es un investigador, un redactor, un revisor y un operador tirando en direcciones distintas, coordinados, con un rastro documental. Hoy el pegamento eres tú: corres prompt tras prompt a mano y unes las piezas por tu cuenta, sin registro de quién hizo qué.

Nirvana-OS te saca del pegamento. Enuncias el resultado en prosa. El motor lo lee, consulta lo que tienes, despacha la combinación adecuada de empresas y squads, los corre en paralelo, reconcilia el resultado detrás de una puerta de calidad y registra cada despacho. Pasas de operador a director: enuncias la meta e inspeccionas el resultado.

## Qué es, en una frase

Nirvana-OS es la capa de orquestación **por encima** de los agentes de terminal. Crea y dirige tres tipos de cosa, y todo lo hace desde lenguaje natural:

- **Empresas (businesses)** — organizaciones autónomas con un organigrama de empleados. Cada empleado llama a squads.
- **Squads** — equipos portátiles de agentes que corren flujos de trabajo reales (DAG, gates, escalación) y entregan resultados terminados.
- **Mind-clones** — ADN de persona (5 capas) inyectado en los empleados para que piensen y hablen con el método de un maestro.

Una sola petición puede movilizar a muchos de ellos al mismo tiempo. El orquestador (el `harness`) elige el reparto. Tú solo describes el resultado.

## Míralo funcionar: todo es una frase

Esta es la parte que importa. No escribes código, no rellenas formularios, no editas configuración. Le hablas al sistema, dentro del runtime de IA que ya usas, nombrándolo: **"usa Nirvana-OS para…"**. Así se ve.

### 1. Construye una empresa describiéndola

Dale la jerarquía y los roles en prosa. Diseña la organización, escribe cada empleado, conecta los flujos de trabajo y valida el resultado.

```text
Usa Nirvana-OS para crear una empresa llamada podcast-empire que produzca, publique
y monetice 3 podcasts a la vez. Cada programa tiene su propio nicho, un presentador
de IA, un calendario editorial y un embudo de monetización independiente. Unos 7 empleados.
```

El sistema corre su fábrica de empresas: lectura de intención, investigación de dominio, un plano organizacional que apruebas, y luego empleados, memoria y flujos de trabajo, validados contra el Business Protocol. Terminas con `~/businesses/podcast-empire/`, con personal y listo para correr.

### 2. O deja que el sistema diseñe la empresa por ti

¿No sabes aún cuál es la estructura correcta? Pregunta. Este es el flujo del que la mayoría se enamora.

**Paso uno, pide el diseño:**

```text
Usa Nirvana-OS: ¿cómo se estructuraría una agencia de marketing completa y moderna?
Dame la jerarquía, los roles clave y quiénes son los mejores especialistas del mundo
para cada puesto.
```

El sistema responde con un organigrama real: un director creativo, un jefe de performance, un jefe de redacción, un líder de contenido, un estratega, y los nombres de los operadores cuyos métodos debería encarnar cada puesto.

**Paso dos, clona a esos especialistas:**

```text
Excelente. Clona a esos especialistas en mind-clones que pueda contratar.
```

Corre la fábrica de mind-clones y produce ADN de persona para cada uno: el pensamiento, las heurísticas y la voz de ese tipo de operador.

**Paso tres, construye la empresa con ellos en los puestos:**

```text
Ahora construye la agencia, y pon esos clones en los roles correspondientes como
el cerebro de cada empleado.
```

Ensambla la empresa, asigna cada mind-clone al empleado correcto y crea cualquier squad especialista que la agencia necesite pero aún no tenga. Hiciste tres preguntas en español llano y obtuviste una empresa con personal.

### 3. Crea un squad especialista en prosa

Cuando una empresa necesita una capacidad que ningún equipo existente cubre, describe el equipo que quieres.

```text
Usa Nirvana-OS para generar un squad de automatización de e-commerce headless, con
agentes para catálogo, checkout, inventario y soporte. Valídalo contra el
Squad Protocol.
```

Sale `~/squads/…/` con agentes, tareas, flujos de trabajo, esquemas, una configuración de harness y un README, todo validado.

### 4. Clona a un experto en prosa

Convierte la obra pública de cualquiera en un asesor que tus empleados pueden usar.

```text
Usa Nirvana-OS para convertir la obra pública de <autor> en un mind-clone de IA
completo a través de la genius factory.
```

La fábrica extrae un ADN de 5 capas (filosofías, modelos mentales, heurísticas, frameworks, metodologías), construye la persona, la pasa por un panel de otras mentes y entrega un asesor que puedes soltar en cualquier empresa.

### 5. Una frase, muchos equipos a la vez

Al orquestador le encanta movilizar varias empresas y squads desde un solo brief.

```text
Usa Nirvana-OS para producir un paquete de lanzamiento: investigación de mercado,
copy de landing page y un desglose competitivo.
```

Esa sola línea puede convocar un squad de investigación, un squad de copy y una empresa de diseño en paralelo, cada uno con empleados que llevan los mind-clones adecuados, reconciliados detrás de una única puerta de calidad. También puedes forzar un carril desde la CLI: `nrv use-businesses "…"` o `nrv use-squads "…"`.

> Toda la interfaz es prosa más un recibo. Sin llamadas a API, sin archivos de configuración. Solo describe el resultado y lee el rastro de auditoría que prueba lo que pasó.

## Instala en 60 segundos

La misma idea en cada sistema operativo: instala Bun una vez, luego corre un comando. También necesitas Node.js para `npx` (la mayoría de las máquinas ya lo tienen; si no, [nodejs.org](https://nodejs.org)).

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # recarga el PATH, o simplemente abre una nueva terminal
npx @nirvana-os/cli        # instala el motor
```

### Windows (nativo, sin WSL)

Todo el sistema corre sobre Bun, así que Windows solo necesita Bun. En **PowerShell**:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# abre una NUEVA ventana de PowerShell para que el PATH se actualice
npx @nirvana-os/cli
```

El instalador deja el comando `nrv` en `~/.local/bin` (`%USERPROFILE%\.local\bin` en Windows) y lo agrega a tu PATH automáticamente. Abre una nueva terminal y confirma:

```bash
nrv --help
```

Re-ejecutar `npx @nirvana-os/cli` es idempotente y siempre trae el motor más reciente.

## Echa un vistazo con `nrv`

Los comandos de descubrimiento son de solo lectura y seguros en cualquier momento.

```bash
nrv glance            # vista general de una pantalla de lo que tienes
nrv list-businesses   # organizaciones registradas localmente
nrv list-squads       # los equipos de agentes
nrv list-clones       # ADN de persona disponible para inyectar
nrv search "launch"   # encuentra capacidades en los tres registros
```

Un motor recién instalado devuelve vacío aquí, y ese es el punto. La fábrica está instalada; la carga no.

## Los tres pilares

Todo lo que el motor crea y orquesta es una de tres cosas. Este es el modelo mental completo.

| Pilar | Qué es | Dónde vive |
|---|---|---|
| **Empresas** | Organizaciones autónomas, cada una con un organigrama de empleados | `~/businesses/` |
| **Squads** | Equipos de agentes portátiles que corren flujos de trabajo (DAG, gates, escalación) | `~/squads/` |
| **Mind-clones** | ADN de persona inyectado en los empleados para voz y juicio | `~/businesses/_library/dna/` |

Una empresa orquesta empleados. Un empleado llama a squads. Un squad corre agentes. Un mind-clone le da a cualquiera de ellos una voz más verdadera. Un solo brief rara vez necesita uno solo.

## Puedes hacer más de todo: las metaherramientas

El motor trae tres fábricas, y se llaman entre sí. Así es como una empresa que pediste en una frase termina completa.

- **Business Creator** convierte un brief en prosa en una organización entera: empleados, memoria, flujos de trabajo, validados de extremo a extremo. Cuando necesita una capacidad que ningún squad cubre, delega al Squad Creator.
- **Squad Creator** convierte un brief en prosa en un squad validado: agentes, tareas, flujos de trabajo, esquemas, configuración de harness, README.
- **Genius Factory** convierte la obra pública de una persona en un mind-clone a través de un pipeline de 5 etapas, y luego te entrega un asesor listo para contratar.

Metaherramientas llamando a metaherramientas es por qué "diseña la agencia, clona a los especialistas, constrúyela" funciona como tres frases llanas.

## Cómo funciona

Dale al harness un brief y hace cinco cosas, en orden:

1. Lee el brief.
2. Consulta los tres registros: empresas, squads, mind-clones.
3. Despacha la mejor combinación, que puede ser muchas empresas y/o squads en paralelo.
4. Reconcilia los resultados detrás de una puerta de calidad.
5. Escribe un rastro de auditoría en `~/.harness-logs/<date>/audit.jsonl`.

```
                       brief
                         │
                         ▼
                ┌───────────────────┐
                │ harness (maestro) │
                │ leer · enrutar ·  │
                │ despachar         │
                └───────────────────┘
                         │
        consulta los tres registros
       (empresas · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  empresa A │   │  squad X   │    │  mind-clones │
 │ empleados  │   │  workflow  │◀───│ inyectados   │
 │  → squads  │   │  DAG·gates │    │ como ADN     │
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └───── despacho en paralelo ───┘
                         │
                         ▼
                ┌───────────────────┐
                │ puerta de calidad │
                │ reconciliar salida│
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
     resultado final      ~/.harness-logs/<date>/audit.jsonl
                          (cada despacho, registrado)
```

El paralelismo es la cuña: un brief puede poner a trabajar a varios equipos en la misma corrida y reunir su salida al final. El rastro de auditoría es la confianza: abre el log y rastrea qué agentes corrieron, sobre qué brief, en qué orden y por qué. El trabajo agéntico deja de ser una caja negra.

## Una instalación, todos los runtimes

Hay un solo árbol de skills en `~/.nirvana/skills`, enlazado a cada runtime que el instalador detecta. Nirvana-OS no te pide cambiar de agente. Mejora el que ya tienes.

| Runtime | Estado |
|---|---|
| Claude Code | Siempre enlazado |
| Codex | Enlazado si está presente |
| Gemini-CLI | Enlazado si está presente |
| Antigravity (`agy`) | Enlazado si está presente |
| Hermes | Puente opcional |

## Open core: el motor es gratis, y sigue siendo gratis

El motor de este repo es gratis, sin un nivel mutilado ni nada básico bajo llave. Crea y orquesta empresas, squads y mind-clones desde cero. Si quieres construir tu propio conglomerado desde cero, el motor es todo lo que necesitarás y no debes nada.

La capa de pago es **contenido, no capacidad**: colecciones curadas y listas para correr de squads, empresas y mind-clones, entregadas a través de [squads.sh](https://squads.sh).

| | Motor gratis (este repo) | Packs de pago (squads.sh) |
|---|---|---|
| Crear desde cero | Sí | Sí |
| Orquestar en paralelo | Sí | Sí |
| Rastro de auditoría en cada despacho | Sí | Sí |
| Instalación multi-runtime | Sí | Sí |
| Squads, empresas y mind-clones prefabricados | Ninguno, vacío por diseño | Un conglomerado completo, listo para correr |
| Tiempo hasta un conglomerado funcional | Lo construyes tú | El primer día |

La diferencia que compran los packs es **tiempo, no poder**. El buque insignia, **Genesis Circle**, deja 39 squads de producción, 11 empresas y 159 mind-clones en una sola instalación. Un pack se superpone al motor: cómpralo, corre `bun setup.ts` y mantenlo al día con `nrv update <slug>`. [Mira los packs en squads.sh](https://squads.sh).

## Comandos `nrv`

| Comando | Qué hace |
|---|---|
| `nrv route "<brief>"` | Entrega al maestro un brief en prosa |
| `nrv use-businesses "<brief>"` | Enruta un brief, empresa primero |
| `nrv use-squads "<brief>"` | Enruta un brief, squad primero |
| `nrv glance` | Vista general de una pantalla de tu configuración |
| `nrv list-businesses` / `list-squads` / `list-clones` | Explora los registros (solo lectura) |
| `nrv search "<topic>"` | Busca capacidades en los tres registros |
| `nrv init <path>` | Inicializa un nuevo proyecto |
| `nrv update <slug>` | Actualiza un pack instalado |
| `nrv --help` | Referencia completa de comandos |

Referencia completa: [docs/CLI.md](./docs/CLI.md).

## Preguntas frecuentes

**¿Necesito saber programar?** No. Describes resultados en lenguaje natural. El sistema escribe, valida y corre el código.

**¿Reemplaza a mi agente?** No. Corre sobre Claude Code, Codex, Gemini-CLI o Antigravity, y hace que el que ya tienes orqueste a muchos.

**¿Dónde vive mi trabajo?** En tu máquina, bajo `~/businesses`, `~/squads` y `~/businesses/_library/dna`. Local-first, sin ninguna nube de terceros en el medio.

**¿El motor es realmente gratis?** Sí. Los packs de pago son contenido prefabricado que te ahorra tiempo. El motor construye las mismas cosas desde cero sin costo.

**¿Windows?** Nativo, a través de Bun. No se requiere WSL.

## Licencia, autoría y estado

Autor: **Luiz Gustavo Vieira Rodrigues (Prospecteezy)**. Sin coautores.

Licencia: la Nirvana-OS Sustainable Use License (SUL). El código se publica de forma abierta y source-available. No es una licencia de código abierto aprobada por la OSI, y ciertos usos comerciales requieren una licencia comercial aparte. Lee los términos completos en [LICENSE](./LICENSE) antes de apoyarte en cualquier resumen.

Estado: beta (0.x). El motor funciona hoy e instala en minutos. Espera que la superficie siga moviéndose hasta la 1.0.
