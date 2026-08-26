import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BusinessManifestSchema, SquadManifestSchema } from '../../_shared/validators/validators'

const { CompatibilityChecker } = require('../lib/compatibility-checker')
const { SquadDiscovery } = require('../lib/discovery')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nirvana-runtime-policy-'))
  mkdirSync(join(root, 'adapters'))
  writeFileSync(join(root, 'adapters', 'test-runtime.yaml'), `
adapter:
  runtime_id: test-runtime
  protocol_version: "5.0"
features_supported:
  - id: file_read
features_unsupported:
  - id: telemetry_otel
    fallback: Telemetry disabled.
concept_mapping: {}
invocation: {}
`)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const baseSquad = {
  name: 'test-squad', version: '1.0.0', protocol: '5.0' as const,
  components: {},
}

describe('runtime_requirements.policy', () => {
  test('legacy manifests default to declared and still require minimum', () => {
    expect(SquadManifestSchema.safeParse({
      ...baseSquad, runtime_requirements: { minimum: [{ runtime: 'codex' }] },
    }).success).toBe(true)
    expect(SquadManifestSchema.safeParse({
      ...baseSquad, runtime_requirements: {},
    }).success).toBe(false)
  })

  test('active policy permits omitting minimum for squads and businesses', () => {
    expect(SquadManifestSchema.safeParse({
      ...baseSquad, runtime_requirements: { policy: 'active', incompatible: [] },
    }).success).toBe(true)
    const business = {
      name: 'test-business', version: '1.0.0', protocol: '1.0',
      description: 'A sufficiently detailed test business description.',
      domains: ['engineering'], operation_mode: 'zero_human',
      runtime_requirements: { policy: 'active', incompatible: [] },
    }
    expect(BusinessManifestSchema.safeParse(business).success).toBe(true)
  })

  test('active policy uses a registered adapter and degrades optional features', () => {
    const checker = new CompatibilityChecker(root)
    const result = checker.checkCompatibility({
      protocol: '5.0', runtimePolicy: 'active', runtimes: [],
      featuresRequired: ['file_read'], featuresOptional: ['telemetry_otel'],
    }, 'test-runtime')
    expect(result.compatible).toBe(true)
    expect(result.degradations).toHaveLength(1)
  })

  test('active policy accepts an explicit bridge and rejects missing required features', () => {
    const checker = new CompatibilityChecker(root)
    const info = { protocol: '5.0', runtimePolicy: 'active', runtimes: [], featuresRequired: ['file_read'] }
    expect(checker.checkCompatibility(info, 'future-runtime', { protocolVersion: '5.0', featuresSupported: ['file_read'] }).compatible).toBe(true)
    const missing = checker.checkCompatibility(info, 'future-runtime', { protocolVersion: '5.0', featuresSupported: [] })
    expect(missing.compatible).toBe(false)
    expect(missing.errors[0]).toContain("REQUIRED feature 'file_read'")
    const all = checker.checkAllRuntimes(info, 'future-runtime', {
      protocolVersion: '5.0', featuresSupported: ['file_read'],
    })
    expect(all.get('future-runtime').compatible).toBe(true)
  })

  test('active policy fails without adapter or bridge and honors incompatible', () => {
    const checker = new CompatibilityChecker(root)
    const missing = checker.checkCompatibility({ runtimePolicy: 'active', runtimes: [] }, 'unknown')
    expect(missing.compatible).toBe(false)
    expect(missing.errors[0]).toContain('no active runtime bridge')
    const denied = checker.checkCompatibility({
      runtimePolicy: 'active', runtimes: [{ runtime: 'test-runtime', type: 'incompatible' }],
    }, 'test-runtime')
    expect(denied.compatible).toBe(false)
    expect(denied.errors[0]).toContain('explicitly declares')
  })

  test('declared policy rejects an undeclared active runtime', () => {
    const checker = new CompatibilityChecker(root)
    const result = checker.checkCompatibility({
      runtimePolicy: 'declared', runtimes: [{ runtime: 'other', type: 'minimum' }],
    }, 'test-runtime')
    expect(result.compatible).toBe(false)
    expect(result.errors[0]).toContain('not declared')
  })

  test('discovery preserves policy and all runtime list types', () => {
    const parsed = { runtime_requirements: {
      policy: 'active', minimum: [{ runtime: 'codex' }],
      compatible: [{ runtime: 'gemini-cli' }], incompatible: [{ runtime: 'openclaw' }],
    } }
    expect(SquadDiscovery.parseRuntimes(parsed)).toEqual([
      { runtime: 'codex', type: 'minimum' },
      { runtime: 'gemini-cli', type: 'compatible' },
      { runtime: 'openclaw', type: 'incompatible' },
    ])
  })
})
