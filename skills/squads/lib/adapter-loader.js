/**
 * Adapter Loader — Load and validate runtime adapter manifests
 *
 * Adapters live at {skill-root}/adapters/{runtime_id}.yaml
 * Each adapter declares features_supported, concept_mapping, numeric_values.
 * Validated against schemas/adapter-schema.json.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

class AdapterLoader {
  /**
   * @param {string} skillRoot - Path to the squads skill directory
   */
  constructor(skillRoot) {
    this.skillRoot = skillRoot;
    this.adaptersDir = path.join(skillRoot, 'adapters');
    this.cache = new Map();
  }

  /**
   * List all available adapter IDs
   * @returns {string[]} Array of runtime_id strings
   */
  listAdapters() {
    try {
      const files = fs.readdirSync(this.adaptersDir);
      return files
        .filter(f => f.endsWith('.yaml') && !f.startsWith('_'))
        .map(f => f.replace('.yaml', ''));
    } catch (error) {
      console.error(`[ERROR] Cannot list adapters: ${error.message}`);
      return [];
    }
  }

  /**
   * Load an adapter manifest by runtime_id
   * @param {string} runtimeId - e.g., 'claude-code', 'codex', 'gemini-cli'
   * @returns {object|null} Parsed adapter manifest or null on error
   */
  loadAdapter(runtimeId) {
    if (this.cache.has(runtimeId)) return this.cache.get(runtimeId);

    const yamlPath = path.join(this.adaptersDir, `${runtimeId}.yaml`);

    if (!fs.existsSync(yamlPath)) {
      console.warn(`[WARN] Adapter not found: ${runtimeId}`);
      return null;
    }

    try {
      const content = fs.readFileSync(yamlPath, 'utf-8');
      const parsed = yaml.parse(content);

      if (!parsed.adapter || !parsed.adapter.runtime_id) {
        throw new Error('Missing adapter.runtime_id');
      }

      this.cache.set(runtimeId, parsed);
      return parsed;
    } catch (error) {
      console.error(`[ERROR] Failed to load adapter ${runtimeId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get the feature support matrix for a runtime
   * @param {string} runtimeId
   * @returns {{ supported: Map<string, object>, unsupported: Map<string, object> }}
   */
  getFeatureMatrix(runtimeId) {
    const adapter = this.loadAdapter(runtimeId);
    if (!adapter) return { supported: new Map(), unsupported: new Map() };

    const supported = new Map();
    const unsupported = new Map();

    (adapter.features_supported || []).forEach(f => supported.set(f.id, f));
    (adapter.features_unsupported || []).forEach(f => unsupported.set(f.id, f));

    return { supported, unsupported };
  }

  /**
   * Resolve a portable tool name to a runtime-local name
   * @param {string} runtimeId
   * @param {string} portableName - e.g., 'read', 'grep', 'bash'
   * @returns {string|null} Runtime-local tool name or null
   */
  resolveToolName(runtimeId, portableName) {
    const adapter = this.loadAdapter(runtimeId);
    if (!adapter || !adapter.concept_mapping || !adapter.concept_mapping.tools) return null;

    const semanticMap = adapter.concept_mapping.tools.semantic_map;
    if (!semanticMap) return null;

    const resolved = semanticMap[portableName];
    if (Array.isArray(resolved)) return resolved[0];
    return resolved || null;
  }

  /**
   * Resolve a model family hint to a concrete model identifier
   * @param {string} runtimeId
   * @param {string} familyHint - e.g., 'sonnet', 'opus', 'haiku'
   * @returns {string|null} Concrete model ID or null
   */
  resolveModel(runtimeId, familyHint) {
    const adapter = this.loadAdapter(runtimeId);
    if (!adapter || !adapter.concept_mapping || !adapter.concept_mapping.model) return null;

    const resolution = adapter.concept_mapping.model.resolution;
    return resolution ? resolution[familyHint] || null : null;
  }

  /**
   * Get numeric values for a runtime (context window, compaction, etc.)
   * @param {string} runtimeId
   * @returns {object} Numeric values or empty object
   */
  getNumericValues(runtimeId) {
    const adapter = this.loadAdapter(runtimeId);
    return (adapter && adapter.numeric_values) || {};
  }

  /**
   * Get adapter-specific validators
   * @param {string} runtimeId
   * @returns {object[]} Array of validator definitions
   */
  getValidators(runtimeId) {
    const adapter = this.loadAdapter(runtimeId);
    return (adapter && adapter.validators) || [];
  }

  /**
   * Get adapter metadata summary (for display)
   * @param {string} runtimeId
   * @returns {object|null}
   */
  getAdapterInfo(runtimeId) {
    const adapter = this.loadAdapter(runtimeId);
    if (!adapter) return null;

    const a = adapter.adapter;
    const supportedCount = (adapter.features_supported || []).length;
    const unsupportedCount = (adapter.features_unsupported || []).length;

    return {
      runtimeId: a.runtime_id,
      name: a.runtime_name,
      vendor: a.vendor,
      adapterVersion: a.adapter_version,
      protocolVersion: a.protocol_version,
      minRuntimeVersion: a.minimum_runtime_version,
      status: a.status || 'unknown',
      featuresSupported: supportedCount,
      featuresUnsupported: unsupportedCount,
    };
  }
}

module.exports = { AdapterLoader };
