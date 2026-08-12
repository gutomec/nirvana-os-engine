/**
 * Compatibility Checker — Verify squad ↔ adapter feature compatibility
 *
 * Checks features_required against adapter features_supported.
 * Logs graceful degradation for features_optional not supported.
 * Implements Core P9 (Graceful Degradation) and P5 (Fail-Closed).
 */

const { AdapterLoader } = require('./adapter-loader');

class CompatibilityChecker {
  /**
   * @param {string} skillRoot - Path to the squads skill directory
   */
  constructor(skillRoot) {
    this.adapterLoader = new AdapterLoader(skillRoot);
  }

  /**
   * Check full compatibility of a squad against a runtime adapter
   *
   * @param {object} squadInfo - Squad metadata (from discovery or parsed squad.yaml)
   * @param {string} runtimeId - Target runtime adapter ID
   * @returns {{
   *   compatible: boolean,
   *   errors: string[],
   *   warnings: string[],
   *   degradations: { feature: string, fallback: string }[]
   * }}
   */
  checkCompatibility(squadInfo, runtimeId) {
    const result = {
      compatible: true,
      errors: [],
      warnings: [],
      degradations: [],
    };

    // Load adapter
    const adapter = this.adapterLoader.loadAdapter(runtimeId);
    if (!adapter) {
      result.compatible = false;
      result.errors.push(`Adapter '${runtimeId}' not found or failed to load.`);
      return result;
    }

    const { supported, unsupported } = this.adapterLoader.getFeatureMatrix(runtimeId);

    // Check features_required (fail-closed: all must be supported)
    const required = squadInfo.featuresRequired || [];
    for (const feature of required) {
      if (!supported.has(feature)) {
        result.compatible = false;
        const info = unsupported.get(feature);
        const fallbackNote = info && info.fallback ? ` Fallback: ${info.fallback}` : '';
        result.errors.push(
          `REQUIRED feature '${feature}' is not supported by '${runtimeId}'.${fallbackNote}`
        );
      }
    }

    // Check features_optional (graceful degradation: log, continue)
    const optional = squadInfo.featuresOptional || [];
    for (const feature of optional) {
      if (!supported.has(feature)) {
        const info = unsupported.get(feature);
        const fallback = (info && info.fallback) || 'Feature skipped.';
        result.degradations.push({ feature, fallback });
        result.warnings.push(
          `OPTIONAL feature '${feature}' not supported by '${runtimeId}'. Degradation: ${fallback}`
        );
      }
    }

    // Check runtime_requirements.incompatible
    if (squadInfo.runtimes) {
      const incompatible = squadInfo.runtimes
        .filter(r => r.type === 'incompatible')
        .map(r => r.runtime);

      if (incompatible.includes(runtimeId)) {
        result.compatible = false;
        result.errors.push(
          `Squad explicitly declares '${runtimeId}' as incompatible.`
        );
      }
    }

    // Check protocol version
    const adapterProtocol = adapter.adapter.protocol_version;
    if (squadInfo.protocol && adapterProtocol) {
      const squadMajor = parseInt(squadInfo.protocol);
      const adapterMajor = parseInt(adapterProtocol);
      if (squadMajor > adapterMajor) {
        result.compatible = false;
        result.errors.push(
          `Squad targets protocol ${squadInfo.protocol} but adapter supports ${adapterProtocol}.`
        );
      }
    }

    return result;
  }

  /**
   * Check compatibility against all declared runtimes
   *
   * @param {object} squadInfo
   * @returns {Map<string, object>} runtimeId → compatibility result
   */
  checkAllRuntimes(squadInfo) {
    const results = new Map();
    const runtimes = squadInfo.runtimes || [];

    for (const r of runtimes) {
      results.set(r.runtime, this.checkCompatibility(squadInfo, r.runtime));
    }

    return results;
  }

  /**
   * Format compatibility report for display
   *
   * @param {object} result - From checkCompatibility()
   * @param {string} runtimeId
   * @returns {string} Formatted report
   */
  formatReport(result, runtimeId) {
    const lines = [];
    const icon = result.compatible ? '✅' : '❌';
    lines.push(`${icon} Runtime: ${runtimeId}`);
    lines.push('');

    if (result.errors.length > 0) {
      lines.push('  Errors:');
      result.errors.forEach(e => lines.push(`    ✗ ${e}`));
    }

    if (result.degradations.length > 0) {
      lines.push('  Degradations:');
      result.degradations.forEach(d =>
        lines.push(`    ⚠ ${d.feature}: ${d.fallback}`)
      );
    }

    if (result.warnings.length > 0 && result.degradations.length === 0) {
      lines.push('  Warnings:');
      result.warnings.forEach(w => lines.push(`    ⚠ ${w}`));
    }

    if (result.errors.length === 0 && result.degradations.length === 0) {
      lines.push('  All features fully supported.');
    }

    return lines.join('\n');
  }
}

module.exports = { CompatibilityChecker };
