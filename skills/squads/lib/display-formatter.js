/**
 * Squad Display Formatter — Beautiful Terminal Output
 *
 * Provides multiple formatting styles for squad listings:
 * - Table: Organized columns with borders
 * - Card: Individual squad cards with details
 * - Compact: One-liner per squad
 * - Tree: Hierarchical by type
 */

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background colors (for highlights)
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

class SquadDisplayFormatter {
  /**
   * Format squads for beautiful terminal display
   */
  static format(squads, style = 'table', options = {}) {
    if (squads.length === 0) {
      return this.formatEmpty();
    }

    switch (style) {
      case 'table':
        return this.formatTable(squads, options);
      case 'card':
        return this.formatCards(squads, options);
      case 'compact':
        return this.formatCompact(squads, options);
      case 'tree':
        return this.formatTree(squads, options);
      default:
        return this.formatTable(squads, options);
    }
  }

  /**
   * Beautiful Table Format
   */
  static formatTable(squads, options = {}) {
    const sorted = this.sortSquads(squads, options);
    const grouped = this.groupByLocation(sorted);

    let output = '\n';

    // Header
    output += `${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`;
    output += `${colors.bold}${colors.green}✓ Found ${squads.length} Squads${colors.reset}`;

    if (grouped.local.length > 0) {
      output += ` ${colors.dim}(${grouped.local.length} local + ${grouped.home.length} home)${colors.reset}`;
    }
    output += '\n';
    output += `${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n\n`;

    // Local squads section
    if (grouped.local.length > 0) {
      output += this.formatLocationSection(grouped.local, 'Local Workspace', '📂', colors.blue);
    }

    // Home squads section
    if (grouped.home.length > 0) {
      output += this.formatLocationSection(grouped.home, 'Home Directory', '🏠', colors.magenta);
    }

    // Footer
    output += `\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`;
    output += `${colors.dim}Tip: Use *inspect-squad {name} for details | *run-workflow {squad} {workflow} to execute${colors.reset}\n\n`;

    return output;
  }

  /**
   * Format location section with table
   */
  static formatLocationSection(squads, title, icon, titleColor) {
    let output = `${titleColor}${icon} ${title}${colors.reset}\n`;
    output += `${colors.gray}${this.repeat('─', 78)}${colors.reset}\n`;

    // Table header
    output += this.formatTableHeader();

    // Table rows
    for (const squad of squads) {
      output += this.formatTableRow(squad);
    }

    output += `\n`;
    return output;
  }

  /**
   * Format table header
   */
  static formatTableHeader() {
    const cols = {
      name: 25,
      version: 8,
      agents: 10,
      workflows: 12,
      type: 15,
    };

    let header = '';
    header += `${colors.bold}${colors.cyan}`;
    header += this.pad('SQUAD NAME', cols.name);
    header += this.pad('VERSION', cols.version);
    header += this.pad('AGENTS', cols.agents);
    header += this.pad('WORKFLOWS', cols.workflows);
    header += this.pad('TYPE', cols.type);
    header += `${colors.reset}\n`;
    header += `${colors.gray}${this.repeat('─', 78)}${colors.reset}\n`;

    return header;
  }

  /**
   * Format table row
   */
  static formatTableRow(squad) {
    const cols = {
      name: 25,
      version: 8,
      agents: 10,
      workflows: 12,
      type: 15,
    };

    const versionColor = this.getVersionColor(squad.version);
    const typeLabel = squad.harness ? `${colors.green}[v3]${colors.reset}` : `${colors.yellow}[v${squad.version}]${colors.reset}`;

    let row = '';
    row += `${colors.cyan}${this.pad(squad.name, cols.name - 2)}${colors.reset}  `;
    row += this.pad(squad.version, cols.version - 1) + ' ';
    row += this.pad(squad.agents.toString(), cols.agents - 1) + ' ';
    row += this.pad(squad.workflows.toString(), cols.workflows - 1) + ' ';
    row += this.pad(typeLabel.replace(/\x1b\[[0-9;]*m/g, ''), cols.type - 1);
    row += '\n';

    return row;
  }

  /**
   * Card Format (detailed view)
   */
  static formatCards(squads, options = {}) {
    const sorted = this.sortSquads(squads, options);
    let output = '\n';

    output += `${colors.bold}${colors.green}✓ Squad Overview${colors.reset} ${colors.dim}(${squads.length} total)${colors.reset}\n\n`;

    for (const squad of sorted) {
      output += this.formatCard(squad);
    }

    return output;
  }

  /**
   * Format individual card
   */
  static formatCard(squad) {
    const icon = squad.harness ? '⚡' : '📋';
    const location = squad.location === 'local' ? '📂 Local' : '🏠 Home';
    const version = squad.harness ? `${colors.green}v3 (Harness)${colors.reset}` : `${colors.yellow}v${squad.version}${colors.reset}`;

    let card = '';
    card += `┌─ ${icon} ${colors.bold}${squad.name}${colors.reset}\n`;
    card += `│  Version: ${version}\n`;
    card += `│  Location: ${location}\n`;
    card += `│  Agents: ${colors.cyan}${squad.agents}${colors.reset} │ Workflows: ${colors.cyan}${squad.workflows}${colors.reset} │ Tasks: ${colors.cyan}${squad.tasks || 0}${colors.reset}\n`;
    card += `│  Description: ${colors.dim}${squad.description}${colors.reset}\n`;
    card += `└─ ${squad.path}\n\n`;

    return card;
  }

  /**
   * Compact Format (one-liner)
   */
  static formatCompact(squads, options = {}) {
    const sorted = this.sortSquads(squads, options);
    let output = `\n${colors.bold}${colors.green}✓ ${squads.length} Squads${colors.reset}\n\n`;

    for (const squad of sorted) {
      const icon = squad.harness ? '⚡' : '📋';
      const location = squad.location === 'local' ? '📂' : '🏠';
      output += `${icon} ${colors.cyan}${squad.name}${colors.reset} ${location} v${squad.version} ${colors.dim}(${squad.agents}a, ${squad.workflows}w)${colors.reset}\n`;
    }

    output += `\n`;
    return output;
  }

  /**
   * Tree Format (hierarchical)
   */
  static formatTree(squads, options = {}) {
    const grouped = this.groupByType(squads);
    let output = '\n';

    output += `${colors.bold}${colors.cyan}Squad Hierarchy${colors.reset}\n`;
    output += `${colors.gray}${this.repeat('─', 50)}${colors.reset}\n\n`;

    const categories = Object.keys(grouped).sort();

    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      const categorySquads = grouped[category];
      const isLast = i === categories.length - 1;
      const prefix = isLast ? '└── ' : '├── ';

      output += `${colors.bold}${prefix}${category}${colors.reset} ${colors.dim}(${categorySquads.length})${colors.reset}\n`;

      for (let j = 0; j < categorySquads.length; j++) {
        const squad = categorySquads[j];
        const isLastSquad = j === categorySquads.length - 1;
        const squadPrefix = isLast ? '    ' : '│   ';
        const squadLine = isLastSquad ? '└── ' : '├── ';
        const icon = squad.harness ? '⚡' : '📋';

        output += `${squadPrefix}${squadLine}${icon} ${colors.cyan}${squad.name}${colors.reset} ${colors.dim}v${squad.version}${colors.reset}\n`;
      }

      output += '\n';
    }

    return output;
  }

  /**
   * Empty state message
   */
  static formatEmpty() {
    return `
${colors.bold}${colors.yellow}⚠️  No Squads Found${colors.reset}

Searched locations:
  ${colors.dim}• ./squads/${colors.reset}
  ${colors.dim}• ~/squads/${colors.reset}

Getting started:
  1. ${colors.cyan}Create first squad${colors.reset}
     *create-squad my-first-squad

  2. ${colors.cyan}Or import squads${colors.reset}
     cp -r /path/to/squads/* ~/squads/

  3. ${colors.cyan}Debug discovery${colors.reset}
     *list-squads --debug

`;
  }

  /**
   * Helper: Group squads by location
   */
  static groupByLocation(squads) {
    return {
      local: squads.filter(s => s.location === 'local'),
      home: squads.filter(s => s.location === 'home'),
    };
  }

  /**
   * Helper: Group squads by type (based on name pattern)
   */
  static groupByType(squads) {
    const groups = {
      'Meta-Squads': [],
      'Nirvana Squads': [],
      'Specialized': [],
      'Infrastructure': [],
      'Other': [],
    };

    for (const squad of squads) {
      if (['nirvana-squad-creator', 'nirvana-squad-creator-v2', 'nirvana-squad-creator-v3', 'oracle-supreme-squad', 'paperclip-command-center'].includes(squad.name)) {
        groups['Meta-Squads'].push(squad);
      } else if (squad.name.startsWith('nirvana-')) {
        groups['Nirvana Squads'].push(squad);
      } else if (['devops-pipeline', 'data-pipeline', 'ml-pipeline', 'monitoring', 'security-audit', 'incident-response-squad'].includes(squad.name)) {
        groups['Infrastructure'].push(squad);
      } else if (['ultimate-landingpage', 'brandcraft', 'brandcraft-nirvana', 'awwwards-singularity-studio'].includes(squad.name)) {
        groups['Specialized'].push(squad);
      } else {
        groups['Other'].push(squad);
      }
    }

    // Remove empty groups
    return Object.fromEntries(Object.entries(groups).filter(([_, squads]) => squads.length > 0));
  }

  /**
   * Helper: Sort squads
   */
  static sortSquads(squads, options = {}) {
    const sortBy = options.sortBy || 'name';
    const reverse = options.reverse || false;

    let sorted = [...squads];

    if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'version') {
      sorted.sort((a, b) => a.version.localeCompare(b.version));
    } else if (sortBy === 'agents') {
      sorted.sort((a, b) => b.agents - a.agents);
    } else if (sortBy === 'workflows') {
      sorted.sort((a, b) => b.workflows - a.workflows);
    }

    if (reverse) {
      sorted.reverse();
    }

    return sorted;
  }

  /**
   * Helper: Pad string to width
   */
  static pad(str, width) {
    const clean = str.replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI codes for length calculation
    const padding = width - clean.length;
    return str + ' '.repeat(Math.max(0, padding));
  }

  /**
   * Helper: Repeat character
   */
  static repeat(char, count) {
    return char.repeat(count);
  }

  /**
   * Helper: Get color based on version
   */
  static getVersionColor(version) {
    if (version === '3' || version.startsWith('3.')) {
      return colors.green;
    } else if (version === '2' || version.startsWith('2.')) {
      return colors.yellow;
    } else {
      return colors.cyan;
    }
  }
}

module.exports = { SquadDisplayFormatter };
