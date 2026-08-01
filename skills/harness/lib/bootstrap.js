/**
 * First-invocation bootstrap. Idempotent (safe to run any number of times).
 *
 * Creates:
 *   ~/.harness-state/                       (per-skill state, future use)
 *   ~/.harness-logs/<YYYY-MM-DD>/           (today's audit log directory)
 *
 * Does NOT create the registries (those belong to the squads/businesses skills).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

function todayDir() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function bootstrap() {
  const created = [];
  const dirs = [
    path.join(HOME, '.harness-state'),
    path.join(HOME, '.harness-logs', todayDir()),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      created.push(d);
    }
  }
  return { created, dirs };
}

if (require.main === module) {
  const r = bootstrap();
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { bootstrap };
