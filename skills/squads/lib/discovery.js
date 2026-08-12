/**
 * Squad Discovery Engine v4.0 — Runtime-Agnostic
 *
 * PRIMARY METHOD: Bash find (handles tilde expansion natively)
 * FALLBACK: Directory traversal (Node.js fs)
 *
 * v4 additions:
 * - Protocol version detection (v4/v3.1/v2)
 * - runtime_requirements parsing
 * - features_required/optional parsing
 * - Version classification for display
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { SquadDisplayFormatter } = require('./display-formatter');

class SquadDiscovery {
  /**
   * Discover all squads in the current scope (project / global / merge).
   * Returns array of SquadInfo objects, deduplicated by scope precedence
   * (project > global; enumerate() already drops overridden duplicates).
   *
   * Async because the scope resolver lives in _shared/lib/scope.ts and a
   * CommonJS .js file can only reach an ESM/TS module via dynamic import().
   */
  static async discoverAllSquads() {
    try {
      const { resolveScope, enumerate } = await import(
        path.join(__dirname, '..', '..', '_shared', 'lib', 'scope.ts')
      );
      const scope = resolveScope();
      const entries = enumerate(scope, 'squads').filter(e => !e.overridden);
      const squads = [];
      for (const entry of entries) {
        const squadYamlPath = path.join(entry.dir, 'squad.yaml');
        if (!fs.existsSync(squadYamlPath)) continue;
        try {
          squads.push(this.loadSquadInfo(squadYamlPath, entry.source));
        } catch (err) {
          console.warn(`[WARN] Failed to parse ${squadYamlPath}: ${err.message}`);
        }
      }
      return squads.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error(`[ERROR] Discovery failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Discover squads in a single location
   */
  static discoverLocation(location, locationType) {
    const expandedPath = this.expandPath(location);

    if (!this.dirExists(expandedPath)) return [];
    if (!this.isReadable(expandedPath)) {
      console.warn(`[WARN] Directory not readable: ${expandedPath}`);
      return [];
    }

    try {
      return this.discoverViaBashFind(expandedPath, locationType);
    } catch (error) {
      console.warn(`[WARN] Bash find failed, falling back to traversal: ${error.message}`);
      return this.discoverViaTraversal(expandedPath, locationType);
    }
  }

  /**
   * PRIMARY DISCOVERY: Bash find
   */
  static discoverViaBashFind(dir, locationType) {
    const cmd = `find "${dir}" -maxdepth 2 -name "squad.yaml" -type f 2>/dev/null`;

    let output;
    try {
      output = execSync(cmd, { encoding: 'utf-8' });
    } catch (error) {
      throw new Error(`Bash find failed: ${error.message}`);
    }

    const paths = output.trim().split('\n').filter(line => line.length > 0);
    const squads = [];

    for (const squadPath of paths) {
      try {
        const info = this.loadSquadInfo(squadPath, locationType);
        squads.push(info);
      } catch (err) {
        console.warn(`[WARN] Failed to parse ${squadPath}: ${err.message}`);
      }
    }

    return squads;
  }

  /**
   * FALLBACK DISCOVERY: Directory traversal
   */
  static discoverViaTraversal(dir, locationType) {
    const squads = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const squadYamlPath = path.join(dir, entry.name, 'squad.yaml');
        if (!fs.existsSync(squadYamlPath)) continue;

        try {
          const info = this.loadSquadInfo(squadYamlPath, locationType);
          squads.push(info);
        } catch (err) {
          console.warn(`[WARN] Failed to parse ${squadYamlPath}: ${err.message}`);
        }
      }
    } catch (error) {
      throw new Error(`Directory traversal failed: ${error.message}`);
    }

    return squads;
  }

  /**
   * LAZY LOADING: Parse essential metadata + v4 fields
   */
  static loadSquadInfo(yamlPath, location) {
    const content = fs.readFileSync(yamlPath, 'utf-8');

    let parsed;
    try {
      parsed = yaml.parse(content);
    } catch (error) {
      throw new Error(`Invalid YAML: ${error.message}`);
    }

    if (!parsed.name || !parsed.version) {
      throw new Error('Missing required fields: name, version');
    }

    const agents = this.countItems(parsed, 'agents');
    const workflows = this.countItems(parsed, 'workflows');
    const tasks = this.countItems(parsed, 'tasks');

    // v4: Detect protocol version
    const protocolVersion = this.detectProtocolVersion(parsed, yamlPath);

    // v4: Parse runtime requirements
    const runtimes = this.parseRuntimes(parsed);

    // v4: Parse features
    const featuresRequired = parsed.features_required || [];
    const featuresOptional = parsed.features_optional || [];

    return {
      name: parsed.name,
      version: parsed.version,
      protocol: protocolVersion,
      description: parsed.description || '(no description)',
      location,
      path: path.dirname(yamlPath),
      agents,
      workflows,
      tasks,
      runtimes,
      featuresRequired,
      featuresOptional,
      harness: !!parsed.harness,
    };
  }

  /**
   * Detect protocol version from manifest and agent files
   * Returns: '4.0' | '3.1' | '2.0-cc' | '2.0-legacy' | 'unknown'
   */
  static detectProtocolVersion(parsed, yamlPath) {
    // Explicit declaration (v4+)
    if (parsed.protocol) return parsed.protocol;

    // Check for v4 indicators
    if (parsed.runtime_requirements || parsed.features_required) return '4.0';

    // Check for v3 indicators (harness block)
    if (parsed.harness) return '3.x';

    // Check agent files for format detection
    const squadDir = path.dirname(yamlPath);
    const agentFiles = this.getComponentFiles(parsed, 'agents');

    for (const agentFile of agentFiles.slice(0, 1)) {
      try {
        const agentPath = path.join(squadDir, agentFile);
        if (!fs.existsSync(agentPath)) continue;

        const agentContent = fs.readFileSync(agentPath, 'utf-8');
        // Check for nested agent: block (legacy v2)
        if (agentContent.includes('agent:') && agentContent.includes('persona:')) {
          return '2.0-legacy';
        }
        // Check for flat name: + description: (v2 CC or v4)
        if (agentContent.includes('name:') && agentContent.includes('description:')) {
          // v4 has mandatory maxTurns
          if (agentContent.includes('maxTurns:')) return '4.0';
          return '2.0-cc';
        }
      } catch (e) {
        // Ignore parse errors during detection
      }
    }

    return '2.0';
  }

  /**
   * Parse runtime requirements from squad manifest
   */
  static parseRuntimes(parsed) {
    if (!parsed.runtime_requirements) return [];

    const runtimes = [];
    const rr = parsed.runtime_requirements;

    if (Array.isArray(rr.minimum)) {
      rr.minimum.forEach(r => runtimes.push({ runtime: r.runtime, type: 'minimum' }));
    }
    if (Array.isArray(rr.compatible)) {
      rr.compatible.forEach(r => runtimes.push({ runtime: r.runtime, type: 'compatible' }));
    }

    return runtimes;
  }

  /**
   * Get component file paths from manifest (supports both v4 string arrays and legacy objects)
   */
  static getComponentFiles(parsed, type) {
    const items = parsed[type] || (parsed.components && parsed.components[type]) || [];
    return items.map(item => typeof item === 'string' ? item : (item.file || ''));
  }

  /**
   * Count items in squad.yaml
   */
  static countItems(parsed, type) {
    if (Array.isArray(parsed[type])) return parsed[type].length;
    if (parsed.components && Array.isArray(parsed.components[type])) return parsed.components[type].length;
    return 0;
  }

  /**
   * Merge with precedence: local > home
   */
  static mergeAndDeduplicate(localSquads, homeSquads) {
    const byName = new Map();
    homeSquads.forEach(s => byName.set(s.name, s));
    localSquads.forEach(s => byName.set(s.name, s));
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  static expandPath(p) {
    if (p.startsWith('~')) {
      const home = process.env.HOME;
      if (!home) throw new Error('HOME environment variable not set');
      return p.replace('~', home);
    }
    return path.resolve(p);
  }

  static dirExists(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  static isReadable(p) {
    try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
  }

  static formatSquads(squads, style = 'table', options = {}) {
    return SquadDisplayFormatter.format(squads, style, options);
  }
}

module.exports = { SquadDiscovery };
