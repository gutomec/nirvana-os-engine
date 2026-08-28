/**
 * subsystems.ts — what of the engine is standing right now.
 *
 * The cockpit showed what RAN (runs, agents, costs, audit) and never showed what
 * is UP. A grep of views/index.html found zero occurrences of `router`,
 * `supervisor`, `run kernel` and `embeddings`: the operator could read a green
 * timeline while the piece that produced it was gone.
 *
 * Every reading here comes from state already on disk. Three rules bind it:
 *
 *   1. NO INVENTED GREEN. A subsystem whose health cannot be determined answers
 *      `status: null`, and the view renders `—` (the same rule as absence.js).
 *      A dot that lights up on faith is the defect this file exists to avoid.
 *   2. NO SIDE EFFECTS. `openLedger` and `openKernel` both CREATE their database
 *      when it is missing. A health probe that creates the thing it measures
 *      always answers "up", so every open here is guarded by an existence check
 *      and the reading is skipped rather than manufactured.
 *   3. NO NETWORK, NO SPAWN. This runs on every cockpit paint.
 *
 * `up` means standing, `down` means it is not (broken, or deliberately switched
 * off, and the detail says which), `null` means it was not measured.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { paths } from "../../../_shared/lib/bun-helpers.ts";
import { resolveAllSettings, resolveSetting } from "../../../_shared/lib/settings.ts";
import { resolveLedgerDbPath, ACTIVE_STATES } from "../run-ledger.ts";
import { ageMs, checkDisabled, compareVersions, installedVersion, readNotice } from "../../scripts/update-check.ts";
import { getGates } from "./data-loader.ts";

/** `null` is not a third colour: it is the absence of a reading. */
export type SubsystemStatus = "up" | "down" | null;

export interface Subsystem {
  /** Stable id the view keys on. */
  key: string;
  /** What the cell shows. */
  label: string;
  status: SubsystemStatus;
  /** One line, in the user's language, saying what was actually read. */
  detail: string | null;
  /** The file, directory or database the reading came from. */
  source: string | null;
}

const NIRVANA_HOME = () => process.env.NIRVANA_HOME || os.homedir();
const nirvanaDir = () => path.join(NIRVANA_HOME(), ".nirvana");

/** A reading that throws is a reading that did not happen, never a red light. */
function read(key: string, label: string, probe: () => Omit<Subsystem, "key" | "label">): Subsystem {
  try {
    return { key, label, ...probe() };
  } catch (error: any) {
    return { key, label, status: null, detail: `não foi possível ler: ${error?.message || error}`, source: null };
  }
}

/**
 * ROUTER — the registries it matches against.
 *
 * Both modes need them: `fast` runs BM25 over the registry indexes and `agentic`
 * hands them to an agent. Registries with no entries is not a degraded router,
 * it is a router that can only answer NO_MATCH, so it reads as down.
 * router.js itself is not touched or loaded here.
 */
function probeRouter(): Omit<Subsystem, "key" | "label"> {
  const require_ = createRequire(import.meta.url);
  const loader = require_("../registry-loader.js") as { loadAll(): any };
  const { squads, businesses } = loader.loadAll();
  const capabilities = Object.keys(squads?.capabilities || {}).length;
  const squadCount = Object.keys(squads?.squads || {}).length;
  const businessCount = Object.keys(businesses?.businesses || {}).length;
  const mode = resolveSetting("routing.mode").value;
  const total = capabilities + squadCount + businessCount;
  return {
    status: total > 0 ? "up" : "down",
    detail: total > 0
      ? `modo ${mode} · ${squadCount} squads, ${capabilities} capabilities, ${businessCount} businesses`
      : `modo ${mode} · registries vazios: só responde NO_MATCH`,
    // The path the loader actually chose, which its cascade may resolve to the
    // global scope when the project registry is missing or empty.
    source: squads?.source_path || paths.SQUADS_REGISTRY_PATH,
  };
}

/**
 * SUPERVISOR — the run ledger it sweeps.
 *
 * The supervisor is a lazy sweep every dispatch triggers, not a daemon, so what
 * can be read is its ledger. No ledger file means nothing has ever been tracked:
 * undetermined, not down.
 */
function probeSupervisor(): Omit<Subsystem, "key" | "label"> {
  const dbPath = resolveLedgerDbPath();
  if (!fs.existsSync(dbPath)) {
    return { status: null, detail: "ledger ainda não criado: nenhum run foi rastreado nesta casa", source: dbPath };
  }
  const require_ = createRequire(import.meta.url);
  const { Database } = require_("bun:sqlite") as any;
  const db = new Database(dbPath, { readonly: true });
  try {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    const row = db.query(`SELECT COUNT(*) AS n FROM runs WHERE state IN (${placeholders})`).get(...ACTIVE_STATES);
    const active = Number(row?.n || 0);
    return { status: "up", detail: `${active} ${active === 1 ? "run ativo" : "runs ativos"} no ledger`, source: dbPath };
  } finally {
    try { db.close(); } catch { /* the reading is done either way */ }
  }
}

/**
 * QUALITY GATE — the state.db table that records every verdict.
 *
 * `getGates` already answers `available: false` when SQLite is not reachable,
 * which is exactly "could not determine", so it maps to `null` and not to down.
 */
function probeQualityGate(): Omit<Subsystem, "key" | "label"> {
  const probe = getGates({ limit: 1 });
  if (!probe.available) {
    return { status: null, detail: "state.db indisponível: os veredictos não puderam ser lidos", source: null };
  }
  const recorded = probe.gates?.length ? "com veredictos gravados" : "sem veredicto gravado ainda";
  return { status: "up", detail: `quality_gates legível ${recorded}`, source: "state.db" };
}

/**
 * GAUNTLET — no liveness signal exists without a project and a run id.
 *
 * Its projections (`getGauntlet`, `listScorecards`) are per-run reads inside the
 * Run Kernel; there is no engine-wide "the gauntlet is up". What IS readable is
 * how it is configured, so the cell carries that and leaves the light off. This
 * gap is the next cut's input, stated in the report rather than faked here.
 */
function probeGauntlet(): Omit<Subsystem, "key" | "label"> {
  const evaluator = resolveSetting("gauntlet.evaluator").value || "seleção automática";
  const intensity = resolveSetting("gauntlet.default_intensity").value;
  return {
    status: null,
    detail: `sem sinal de saúde fora de um run · avaliador ${evaluator}, intensidade ${intensity}`,
    source: null,
  };
}

/**
 * RUN KERNEL — the per-project event store.
 *
 * Opened read-only and only when the file is already there, so asking the
 * question never answers it. The schema check is the health: a file that exists
 * without the `run_events` table is a kernel that cannot serve a run.
 */
function probeRunKernel(projectRoot: string): Omit<Subsystem, "key" | "label"> {
  const dbPath = path.join(projectRoot, ".nirvana", "run-kernel.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { status: null, detail: "kernel ainda não criado neste projeto: nenhum run canônico foi preparado", source: dbPath };
  }
  const require_ = createRequire(import.meta.url);
  const { Database } = require_("bun:sqlite") as any;
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
    if (!tables.includes("run_events")) {
      return { status: "down", detail: "banco presente sem a tabela run_events", source: dbPath };
    }
    const runs = Number(db.query("SELECT COUNT(DISTINCT run_id) AS n FROM run_events").get()?.n || 0);
    return { status: "up", detail: `${runs} ${runs === 1 ? "run" : "runs"} no kernel deste projeto`, source: dbPath };
  } finally {
    try { db.close(); } catch { /* the reading is done either way */ }
  }
}

/**
 * EMBEDDINGS — the dense arm of the fast router.
 *
 * `routing.dense = off` is the engine default, and off is not broken: it is not
 * standing, and the detail says why. Switched on, the reading is the vector cache
 * on disk, which is what the arm actually consults.
 */
function probeEmbeddings(): Omit<Subsystem, "key" | "label"> {
  const mode = resolveSetting("routing.dense").value;
  const cacheDir = path.join(nirvanaDir(), "cache");
  if (mode === "off") {
    return { status: "down", detail: "desligado (routing.dense = off)", source: cacheDir };
  }
  if (!fs.existsSync(cacheDir)) {
    return { status: null, detail: "routing.dense = fallback, cache de vetores ainda não escrito", source: cacheDir };
  }
  const vectors = fs.readdirSync(cacheDir).filter(f => f.startsWith("dense-") && f.endsWith(".json"));
  return {
    status: "up",
    detail: `routing.dense = fallback · ${vectors.length} ${vectors.length === 1 ? "índice denso" : "índices densos"} em cache`,
    source: cacheDir,
  };
}

/** SETTINGS — the resolver every other subsystem reads its configuration through. */
function probeSettings(): Omit<Subsystem, "key" | "label"> {
  const resolved = resolveAllSettings();
  const pinned = resolved.filter(s => s.source === "env").length;
  const detail = pinned
    ? `${resolved.length} chaves resolvidas · ${pinned} fixadas por variável`
    : `${resolved.length} chaves resolvidas`;
  return { status: "up", detail, source: path.join(nirvanaDir(), "config.yaml") };
}

/** UPDATES — the three-line notice cache the CLI reads before every command. */
function probeUpdates(): Omit<Subsystem, "key" | "label"> {
  const file = path.join(nirvanaDir(), "cache", "update-notice.txt");
  if (checkDisabled()) {
    return { status: "down", detail: "desligado (updates.check = false ou CI)", source: file };
  }
  const age = ageMs(file);
  if (age === Infinity) {
    return { status: null, detail: "nunca verificado: o cache do aviso não existe", source: file };
  }
  const notice = readNotice(file);
  const current = installedVersion();
  const pending = notice && current && compareVersions(notice.latest, current) > 0 ? notice.latest : null;
  const checked = `verificado há ${Math.floor(age / 60_000)} min`;
  return {
    status: "up",
    detail: pending ? `${checked} · ${pending} disponível` : `${checked} · em dia`,
    source: file,
  };
}

/**
 * The engine's subsystems, in the order the cockpit shows them.
 * @param projectRoot the root this Glance serves; the Run Kernel is per-project.
 */
export function readSubsystems(projectRoot: string): Subsystem[] {
  return [
    read("router", "ROUTER", probeRouter),
    read("supervisor", "SUPERVISOR", probeSupervisor),
    read("quality-gate", "QUALITY GATE", probeQualityGate),
    read("gauntlet", "GAUNTLET", probeGauntlet),
    read("run-kernel", "RUN KERNEL", () => probeRunKernel(projectRoot)),
    read("embeddings", "EMBEDDINGS", probeEmbeddings),
    read("settings", "SETTINGS", probeSettings),
    read("updates", "UPDATES", probeUpdates),
  ];
}
