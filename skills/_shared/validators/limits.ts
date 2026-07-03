/**
 * Nirvana Configurable Limits — cascade loader (TypeScript / Bun)
 *
 * Mirror exato de limits.py.
 *
 * Carrega limites de tamanho/contagem com cascata de precedência:
 *
 *   1. NIRVANA_LIMIT_<KEY> env vars              (precedência máxima)
 *   2. <cwd ou ancestral>/.nirvana-limits.yaml   (override do projeto)
 *   3. ~/.claude/nirvana-limits.yaml             (override do usuário)
 *   4. DEFAULTS                                  (valores históricos)
 *
 * Backward-compatible: sem nenhum .yaml e sem env vars, os DEFAULTS são
 * idênticos aos limites originais hard-coded.
 *
 * Toda configuração passa por SAFETY_BOUNDS: valores absurdos são
 * clampados ao piso/teto seguro, com aviso no stderr.
 *
 * Debug: exporte NIRVANA_LIMITS_DEBUG=1.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ──────────────────────────────────────────────────────────────────────
// DEFAULTS — valores históricos do sistema (backward-compatible)
// ──────────────────────────────────────────────────────────────────────

export const DEFAULTS: Record<string, number | null> = {
  // business.yaml — PAYLOAD SIZE (Bucket A)
  // Defaults sized for real multi-dimension companies (the council's manifest
  // alone is ~1245 chars + 43 keywords). All within SAFETY_BOUNDS; override via
  // ~/.claude/nirvana-limits.yaml if you need more.
  business_description_max: 2000,
  business_produces_max: 60,
  business_example_briefs_max: 30,
  business_example_briefs_item_max: 1000,
  business_keywords_max: 100,
  business_capabilities_max: 100,

  // employee frontmatter
  employee_description_max: null, // None = sem teto (histórico)
  employee_max_turns_max: 1000,

  // capability (squad.yaml) — PAYLOAD SIZE
  capability_description_max: 1500,
  capability_produces_max: 40,
  capability_example_briefs_max: 20,
  capability_example_briefs_item_max: 1000,
  capability_keywords_max: 60,

  // squad.yaml
  squad_capabilities_max: 50,

  // mind-clone DNA frontmatter
  dna_max_turns_max: 1000,

  // handoff artifact — PAYLOAD SIZE
  handoff_summary_max: 3000,
  handoff_files_modified_max: 30,

  // business memory GC
  business_memory_max_facts_ceiling: 5000,

  // harness budget — EXECUTION CONTROL (Bucket B — MAX POWER v2)
  // Nirvana fica fora do caminho. Default $1M / 10M tokens / 24h.
  harness_default_max_tokens: 10_000_000,
  harness_default_max_cost_usd: 1_000_000.0,
  harness_default_max_handoffs: 1_000,
  harness_default_max_duration_seconds: 86_400,
}

// ──────────────────────────────────────────────────────────────────────
// SAFETY_BOUNDS — [piso, teto] por chave. null = sem restrição.
// ──────────────────────────────────────────────────────────────────────

const SAFETY_BOUNDS: Record<string, [number | null, number | null]> = {
  business_description_max: [200, 5000],
  business_produces_max: [10, 200],
  business_example_briefs_max: [5, 60],
  business_example_briefs_item_max: [200, 2000],
  business_keywords_max: [15, 300],
  business_capabilities_max: [20, 500],

  employee_description_max: [200, 8000],
  employee_max_turns_max: [50, 1000],

  capability_description_max: [200, 5000],
  capability_produces_max: [8, 120],
  capability_example_briefs_max: [4, 40],
  capability_example_briefs_item_max: [200, 2000],
  capability_keywords_max: [10, 200],

  squad_capabilities_max: [10, 200],

  dna_max_turns_max: [40, 1000],

  handoff_summary_max: [500, 8000],
  handoff_files_modified_max: [5, 100],

  business_memory_max_facts_ceiling: [500, 50_000],

  // MAX POWER v2 — tetos soltos: 100x do default.
  harness_default_max_tokens: [50_000, 100_000_000],
  harness_default_max_cost_usd: [0.1, 100_000_000.0],
  harness_default_max_handoffs: [10, 100_000],
  harness_default_max_duration_seconds: [120, 604_800],
}

const USER_CONFIG = path.join(os.homedir(), '.claude', 'nirvana-limits.yaml')
const PROJECT_CONFIG_NAME = '.nirvana-limits.yaml'
const ENV_PREFIX = 'NIRVANA_LIMIT_'

function log(msg: string): void {
  process.stderr.write(`[nirvana-limits] ${msg}\n`)
}

function coerceScalar(value: string): number | null | boolean | string {
  const v = value.trim()
  if (v === '' || ['null', '~', 'none'].includes(v.toLowerCase())) return null
  if (['true', 'yes', 'on'].includes(v.toLowerCase())) return true
  if (['false', 'no', 'off'].includes(v.toLowerCase())) return false
  const numeric = v.replace(/[_,]/g, '')
  if (/^-?\d+$/.test(numeric)) return parseInt(numeric, 10)
  if (/^-?\d+\.\d+$/.test(numeric)) return parseFloat(numeric)
  return v.replace(/^["']|["']$/g, '')
}

/** Parser de YAML achatado (apenas key: value, sem aninhamento). */
function parseFlatYaml(text: string): Record<string, number | null | boolean | string> {
  const out: Record<string, number | null | boolean | string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    const hashIdx = value.indexOf(' #')
    if (hashIdx !== -1) value = value.slice(0, hashIdx).trim()
    if (!key) continue
    out[key] = coerceScalar(value)
  }
  return out
}

function loadConfigFile(p: string): Record<string, number | null | boolean | string> {
  try {
    if (!fs.existsSync(p)) return {}
    return parseFlatYaml(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    log(`WARN: falha ao ler ${p}: ${e} — ignorando`)
    return {}
  }
}

function findProjectConfig(): string | null {
  let dir = process.cwd()
  while (true) {
    const candidate = path.join(dir, PROJECT_CONFIG_NAME)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function coerceToDefaultType(value: unknown, dft: number | null): number | null {
  if (value === null || value === undefined) return dft === null ? null : dft
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return dft
  return n
}

function applySafetyBounds(key: string, value: number | null): number | null {
  if (value === null) return null
  const bounds = SAFETY_BOUNDS[key]
  if (!bounds) return value
  const [lo, hi] = bounds
  if (lo !== null && value < lo) {
    log(`WARN: ${key}=${value} abaixo do piso seguro ${lo} — clampado para ${lo}`)
    return lo
  }
  if (hi !== null && value > hi) {
    log(`WARN: ${key}=${value} acima do teto seguro ${hi} — clampado para ${hi}`)
    return hi
  }
  return value
}

export function loadLimits(): Record<string, number | null> {
  const limits: Record<string, number | null> = { ...DEFAULTS }
  const sources: Record<string, string> = {}
  for (const k of Object.keys(limits)) sources[k] = 'default'

  // 1. User-level
  const userCfg = loadConfigFile(USER_CONFIG)
  for (const [k, v] of Object.entries(userCfg)) {
    if (k in limits) {
      limits[k] = coerceToDefaultType(v, DEFAULTS[k])
      sources[k] = `user:${USER_CONFIG}`
    } else {
      log(`WARN: chave desconhecida ignorada em ${USER_CONFIG}: ${k}`)
    }
  }

  // 2. Project-level (sobrescreve user)
  const projectPath = findProjectConfig()
  if (projectPath) {
    const projectCfg = loadConfigFile(projectPath)
    for (const [k, v] of Object.entries(projectCfg)) {
      if (k in limits) {
        limits[k] = coerceToDefaultType(v, DEFAULTS[k])
        sources[k] = `project:${projectPath}`
      } else {
        log(`WARN: chave desconhecida ignorada em ${projectPath}: ${k}`)
      }
    }
  }

  // 3. Env vars (precedência máxima)
  for (const k of Object.keys(limits)) {
    const envKey = ENV_PREFIX + k.toUpperCase()
    if (process.env[envKey] !== undefined) {
      const coerced = coerceScalar(process.env[envKey]!)
      limits[k] = coerceToDefaultType(coerced, DEFAULTS[k])
      sources[k] = `env:${envKey}`
    }
  }

  // 4. Safety bounds
  for (const k of Object.keys(limits)) {
    limits[k] = applySafetyBounds(k, limits[k])
  }

  if (process.env.NIRVANA_LIMITS_DEBUG) {
    log('limites efetivos:')
    for (const k of Object.keys(limits).sort()) {
      log(`  ${k} = ${limits[k]}  (fonte: ${sources[k]})`)
    }
  }

  return limits
}

// Singleton — carregado uma vez na importação do módulo.
export const LIMITS: Record<string, number | null> = loadLimits()

// `bun limits.ts` → imprime tabela de limites efetivos.
if (import.meta.main) {
  console.log('Nirvana Configurable Limits — valores efetivos\n')
  for (const key of Object.keys(DEFAULTS).sort()) {
    const eff = LIMITS[key]
    const dft = DEFAULTS[key]
    const marker = eff === dft ? '' : '  ← override'
    console.log(`  ${key.padEnd(42)} = ${String(eff).padStart(12)}  (default ${dft})${marker}`)
  }
}
