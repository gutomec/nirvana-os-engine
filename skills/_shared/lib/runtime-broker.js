class RuntimeBroker {
  constructor(catalog, modelBroker) {
    this.catalog = catalog;
    this.modelBroker = modelBroker;
  }

  evaluateActive(runtimeId, requirements = {}) {
    const match = this.catalog.findRuntime(runtimeId);
    if (!match) {
      return { compatible: false, errors: [`Active runtime '${runtimeId}' has no registered provider descriptor.`], warnings: [], degradations: [] };
    }

    const supported = new Map(Object.entries(match.runtime.capabilities || {}));
    const errors = [];
    for (const featureValue of requirements.featuresRequired || []) {
      const feature = typeof featureValue === 'string'
        ? { id: featureValue, minimumSupport: 'advisory' }
        : { minimumSupport: 'advisory', ...featureValue };
      const actual = supported.get(feature.id)?.support || 'unavailable';
      const rank = { unavailable: 0, advisory: 1, emulated: 2, native: 3 };
      if ((rank[actual] || 0) < (rank[feature.minimumSupport] || 0)) {
        errors.push(`REQUIRED feature '${feature.id}' requires ${feature.minimumSupport}, but '${runtimeId}' provides ${actual}.`);
      }
    }
    if (errors.length) return { compatible: false, errors, warnings: [], degradations: [] };

    const model = this.modelBroker.select({
      providerId: match.provider.provider.id,
      ...(requirements.modelRequirements || {}),
    });
    if (!model.compatible) {
      return { compatible: false, errors: model.errors, warnings: model.warnings, degradations: [], rejectedModels: model.rejected };
    }

    return {
      compatible: true,
      errors: [],
      warnings: model.warnings,
      degradations: [],
      selected: {
        runtime: `${match.runtime.id}@${match.runtime.version || 'unknown'}`,
        provider: match.provider.provider.id,
        model: model.selected.canonical_id,
      },
      evidenceSnapshot: model.evidenceSnapshot,
    };
  }
}

module.exports = { RuntimeBroker };
