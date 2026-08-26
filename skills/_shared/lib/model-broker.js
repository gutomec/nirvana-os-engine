const SUPPORT_RANK = { unavailable: 0, advisory: 1, emulated: 2, native: 3 };

function normalizeRequirement(requirement) {
  return typeof requirement === 'string'
    ? { id: requirement, minimumSupport: 'advisory' }
    : { minimumSupport: 'advisory', ...requirement };
}

class ModelBroker {
  constructor(catalog) {
    this.catalog = catalog;
  }

  select({ providerId, requiredCapabilities = [], inputModalities = [], outputModalities = [], allowStale = false }) {
    const provider = this.catalog.providers.get(providerId);
    if (!provider) return this.failure(`Provider '${providerId}' is not registered.`);

    const freshness = this.catalog.freshness(provider);
    if (freshness.stale && !allowStale) {
      return this.failure(`Provider '${providerId}' model catalog is stale.`, { stale: true });
    }

    const rejected = [];
    const candidates = this.catalog.listModels(providerId).filter(model => {
      const reasons = [];
      for (const requirementValue of requiredCapabilities) {
        const requirement = normalizeRequirement(requirementValue);
        const actual = model.capabilities?.[requirement.id]?.support || 'unavailable';
        if ((SUPPORT_RANK[actual] || 0) < (SUPPORT_RANK[requirement.minimumSupport] || 0)) {
          reasons.push(`capability '${requirement.id}' requires ${requirement.minimumSupport}, model provides ${actual}`);
        }
      }
      for (const modality of inputModalities) {
        if (!model.modalities?.input?.includes(modality)) reasons.push(`input modality '${modality}' is unavailable`);
      }
      for (const modality of outputModalities) {
        if (!model.modalities?.output?.includes(modality)) reasons.push(`output modality '${modality}' is unavailable`);
      }
      if (reasons.length) rejected.push({ model: model.canonical_id, reasons });
      return reasons.length === 0;
    });

    if (!candidates.length) {
      return this.failure(`No model from provider '${providerId}' satisfies the required capabilities and modalities.`, { rejected, stale: freshness.stale });
    }

    candidates.sort((left, right) => (right.priority || 0) - (left.priority || 0) || left.canonical_id.localeCompare(right.canonical_id));
    return {
      compatible: true,
      selected: structuredClone(candidates[0]),
      rejected,
      warnings: freshness.stale ? [`Provider '${providerId}' model catalog is stale.`] : [],
      evidenceSnapshot: {
        providerId,
        observedAt: freshness.observedAt,
        modelIds: this.catalog.listModels(providerId).map(model => model.canonical_id),
      },
    };
  }

  failure(error, extra = {}) {
    return { compatible: false, errors: [error], rejected: [], warnings: [], ...extra };
  }
}

module.exports = { ModelBroker };
