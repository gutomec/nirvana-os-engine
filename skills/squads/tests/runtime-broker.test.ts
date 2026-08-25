import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const { RuntimeProviderCatalog } = require('../../_shared/lib/runtime-provider-catalog')
const { ModelBroker } = require('../../_shared/lib/model-broker')
const { RuntimeBroker } = require('../../_shared/lib/runtime-broker')
const { CompatibilityChecker } = require('../lib/compatibility-checker')

const fixtureDirectory = join(import.meta.dir, 'fixtures', 'runtime-providers')

function createCatalog() {
  return new RuntimeProviderCatalog({ now: () => new Date('2026-08-25T00:00:00Z') })
    .discover(fixtureDirectory)
}

describe('universal runtime and model brokers', () => {
  test('discovers an unknown runtime without a core allowlist edit', () => {
    const catalog = createCatalog()
    expect(catalog.findRuntime('future-runtime')?.provider.provider.id).toBe('fixture-provider')
  })

  test('registers a conforming RuntimeProvider implementation without core changes', () => {
    const catalog = createCatalog()
    const provider = {
      describe: () => ({
        provider: { id: 'plugin-provider' },
        runtimes: [{ id: 'plugin-runtime', capabilities: {} }],
        models: [],
      }),
      prepare: () => ({ handleId: 'prepared' }),
      resume: () => ({ handleId: 'resumed' }),
    }
    catalog.registerProvider(provider)
    expect(catalog.findRuntime('plugin-runtime')?.provider.provider.id).toBe('plugin-provider')
    expect(catalog.getProvider('plugin-provider')).toBe(provider)
    expect(() => catalog.registerProvider({ describe: provider.describe })).toThrow('prepare')
  })

  test('selects the model by required image capability and modality', () => {
    const result = new ModelBroker(createCatalog()).select({
      providerId: 'fixture-provider',
      requiredCapabilities: [{ id: 'image_generation', minimumSupport: 'native' }],
      outputModalities: ['image'],
    })
    expect(result.compatible).toBe(true)
    expect(result.selected.canonical_id).toBe('fixture-provider/image-model/1')
    expect(result.rejected[0].model).toBe('fixture-provider/text-model/1')
  })

  test('fails honestly when a compatible runtime has no compatible model', () => {
    const catalog = createCatalog()
    const broker = new RuntimeBroker(catalog, new ModelBroker(catalog))
    const result = broker.evaluateActive('future-runtime', {
      featuresRequired: ['file_read'],
      modelRequirements: { requiredCapabilities: [{ id: 'video_generation', minimumSupport: 'native' }] },
    })
    expect(result.compatible).toBe(false)
    expect(result.errors[0]).toContain('No model')
  })

  test('eliminates advisory runtime support when native support is required', () => {
    const catalog = createCatalog().register({
      provider: { id: 'advisory-provider' },
      runtimes: [{ id: 'advisory-runtime', capabilities: { sandbox: { support: 'advisory' } } }],
      models: [{ canonical_id: 'advisory-provider/model/1', modalities: { input: ['text'], output: ['text'] }, capabilities: {} }],
    })
    const result = new RuntimeBroker(catalog, new ModelBroker(catalog)).evaluateActive('advisory-runtime', {
      featuresRequired: [{ id: 'sandbox', minimumSupport: 'native' }],
    })
    expect(result.compatible).toBe(false)
    expect(result.errors[0]).toContain('requires native')
  })

  test('blocks stale provider data offline unless policy explicitly allows it', () => {
    const broker = new ModelBroker(createCatalog())
    const blocked = broker.select({ providerId: 'stale-provider' })
    expect(blocked.compatible).toBe(false)
    expect(blocked.stale).toBe(true)
    const allowed = broker.select({ providerId: 'stale-provider', allowStale: true })
    expect(allowed.compatible).toBe(true)
    expect(allowed.warnings[0]).toContain('stale')
  })

  test('uses the active runtime as universal fallback through the compatibility facade', () => {
    const catalog = createCatalog()
    const checker = new CompatibilityChecker(join(import.meta.dir, '..'), {
      runtimeBroker: new RuntimeBroker(catalog, new ModelBroker(catalog)),
    })
    const result = checker.checkCompatibility({
      runtimePolicy: 'active',
      runtimes: [{ runtime: 'missing-declared-runtime', type: 'minimum' }],
      featuresRequired: ['audit_trail'],
      modelRequirements: { requiredCapabilities: ['tool_calling'] },
    }, 'future-runtime')
    expect(result.compatible).toBe(true)
    expect(result.selected.runtime).toBe('future-runtime@1.2.0')
  })

  test('preserves declared policy behavior for legacy manifests', () => {
    const catalog = createCatalog()
    const checker = new CompatibilityChecker(join(import.meta.dir, '..'), {
      runtimeBroker: new RuntimeBroker(catalog, new ModelBroker(catalog)),
    })
    const legacy = require('yaml').parse(require('node:fs').readFileSync(join(import.meta.dir, 'fixtures', 'legacy-squad.yaml'), 'utf8'))
    const result = checker.checkCompatibility({
      runtimePolicy: legacy.runtime_requirements.policy,
      runtimes: legacy.runtime_requirements.minimum.map((entry: { runtime: string }) => ({ runtime: entry.runtime, type: 'minimum' })),
    }, 'future-runtime')
    expect(result.compatible).toBe(false)
    expect(result.errors[0]).toContain('not declared')
  })

  test('accepts provider catalog updates without changing a squad manifest', () => {
    const catalog = createCatalog()
    const broker = new ModelBroker(catalog)
    expect(broker.select({ providerId: 'fixture-provider' }).selected.canonical_id).toBe('fixture-provider/text-model/1')
    const updated = structuredClone(catalog.providers.get('fixture-provider'))
    updated.models.push({
      canonical_id: 'fixture-provider/text-model/2', priority: 20,
      modalities: { input: ['text'], output: ['text'] }, capabilities: { tool_calling: { support: 'native' } },
    })
    catalog.register(updated)
    expect(broker.select({ providerId: 'fixture-provider' }).selected.canonical_id).toBe('fixture-provider/text-model/2')
  })
})
