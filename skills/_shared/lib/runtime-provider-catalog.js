const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

class RuntimeProviderCatalog {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.providers = new Map();
    this.implementations = new Map();
  }

  register(provider) {
    const id = provider?.provider?.id;
    if (!id) throw new Error('Runtime provider descriptor must declare provider.id.');
    this.providers.set(id, structuredClone(provider));
    return this;
  }

  registerProvider(provider) {
    for (const method of ['describe', 'prepare', 'resume']) {
      if (typeof provider?.[method] !== 'function') {
        throw new Error(`RuntimeProvider must implement ${method}().`);
      }
    }
    const descriptor = provider.describe();
    this.register(descriptor);
    this.implementations.set(descriptor.provider.id, provider);
    return this;
  }

  getProvider(providerId) {
    return this.implementations.get(providerId) || null;
  }

  discover(directory) {
    if (!fs.existsSync(directory)) return this;
    for (const filename of fs.readdirSync(directory).sort()) {
      if (!/\.(json|ya?ml)$/i.test(filename)) continue;
      const source = fs.readFileSync(path.join(directory, filename), 'utf8');
      this.register(filename.endsWith('.json') ? JSON.parse(source) : yaml.parse(source));
    }
    return this;
  }

  findRuntime(runtimeId) {
    for (const provider of this.providers.values()) {
      const runtime = (provider.runtimes || []).find(candidate => candidate.id === runtimeId);
      if (runtime) return { provider, runtime };
    }
    return null;
  }

  listModels(providerId) {
    return structuredClone(this.providers.get(providerId)?.models || []);
  }

  freshness(provider) {
    const observedAt = Date.parse(provider.catalog?.observed_at || '');
    const maxAgeSeconds = provider.catalog?.max_age_seconds;
    if (!Number.isFinite(observedAt) || !Number.isFinite(maxAgeSeconds)) {
      return { stale: false, observedAt: null };
    }
    return {
      stale: this.now().getTime() - observedAt > maxAgeSeconds * 1000,
      observedAt: provider.catalog.observed_at,
    };
  }
}

module.exports = { RuntimeProviderCatalog };
