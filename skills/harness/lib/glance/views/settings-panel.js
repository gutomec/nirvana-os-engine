/* settings-panel.js — the logic of the Glance "Configuração" panel, the engine
 * settings section over GET/PUT/DELETE /api/v1/settings.
 *
 * Pure ES module with no dependencies. `bun test` imports it directly; the page
 * loads it through a `<script type="module">` adapter in index.html that exposes
 * the exports as `window.NirvanaSettingsPanel`, because glance.js is a classic
 * script (the same pattern as run-event-labels.js). The module turns the API
 * payload (`schema` from settings-schema.ts, `values` from the resolver) into
 * groups and fields the template renders, maps a control's input back to the
 * value the API receives, builds the requests and reads the API's answers.
 * The server validates every value; nothing here re-implements the schema.
 * UI strings are PT-BR by design.
 */

// One group per schema section, labelled in PT-BR, in schema order. A section
// the map does not know is still shown, under its own name, so a key added to
// the schema never falls off the screen.
export const GROUP_LABELS = Object.freeze({
  multi_target: 'Multi-target', gauntlet: 'Gauntlet', execution: 'Execução', glance: 'Glance', runtime: 'Runtime',
  routing: 'Roteamento', supervisor: 'Supervisor', updates: 'Atualizações', budget: 'Orçamento',
  baselines: 'Baselines de custo', quality_gate: 'Quality gate', delivery: 'Entrega', verify: 'Portão de admissão',
});

export const SOURCE_LABELS = Object.freeze({
  env: 'variável de ambiente', project: 'projeto', global: 'global', 'engine-default': 'engine', default: 'padrão',
});

export const SCOPE_LABELS = Object.freeze({ project: 'projeto', global: 'global' });

const CONTROLS = Object.freeze({ boolean: 'toggle', enum: 'select', number: 'number', string: 'text' });

export function groupLabel(section) {
  return GROUP_LABELS[section] || String(section || '').replace(/_/g, ' ');
}

// The control a key gets: a switch for booleans, a select for enums, a number
// field for numbers, a text field for strings (lists included: the schema
// spells them as one string and validates the shape).
export function controlFor(kind) {
  return CONTROLS[kind] || 'text';
}

export function sourceLabel(entry) {
  const source = entry?.source;
  if (source === 'env') return entry.variable ? `variável ${entry.variable}=${entry.raw ?? ''}` : SOURCE_LABELS.env;
  return SOURCE_LABELS[source] || SOURCE_LABELS.default;
}

// Where the effective value physically comes from: the file for a file source,
// nothing for a variable (its name is already in the source label) or a default.
export function originDetail(entry) {
  if (!entry || entry.source === 'env' || entry.source === 'default') return '';
  return entry.path || '';
}

export function lockReason(entry) {
  if (!entry || entry.source !== 'env') return '';
  return `Fixado pela variável ${entry.variable}=${entry.raw ?? ''} no ambiente do servidor do Glance (o shell que o iniciou ou o .env do projeto); um valor gravado no arquivo só valeria sem a variável. Remova a variável, reinicie o Glance e edite aqui.`;
}

// `nrv config set` writes the project inside one; the panel follows that rule
// and falls back to global for a key that only accepts global (updates.check).
export function defaultScope(field, hasProject = true) {
  const scopes = field?.scopes || [];
  return hasProject && scopes.includes('project') ? 'project' : (scopes[0] || 'global');
}

function fieldOf(spec, entry, allowActions) {
  const dot = spec.key.indexOf('.');
  const value = entry ?? { value: spec.default, source: 'default', path: null, variable: null, raw: null, locked: false };
  const locked = value.locked === true || value.source === 'env';
  return {
    key: spec.key, section: spec.key.slice(0, dot), name: spec.key.slice(dot + 1),
    kind: spec.kind, control: controlFor(spec.kind), description: spec.description || '', expects: spec.expects || '',
    options: spec.options || null, default: spec.default, scopes: spec.scopes || [], env: spec.env || null, envAliases: spec.envAliases || [],
    value: value.value, source: value.source, sourceLabel: sourceLabel(value), origin: originDetail(value),
    path: value.path || null, variable: value.variable || null, raw: value.raw ?? null,
    locked, lockReason: locked ? lockReason(value) : '', writable: !!allowActions && !locked,
  };
}

// Groups and fields for the template, from the GET /api/v1/settings payload.
export function buildSettingsPanel(payload) {
  const schema = Array.isArray(payload?.schema) ? payload.schema : [];
  const values = payload?.values || {};
  const allowActions = payload?.allow_actions === true;
  const groups = [];
  const byId = new Map();
  for (const spec of schema) {
    if (!spec || typeof spec.key !== 'string' || !spec.key.includes('.')) continue;
    const field = fieldOf(spec, values[spec.key], allowActions);
    let group = byId.get(field.section);
    if (!group) { group = { id: field.section, label: groupLabel(field.section), fields: [] }; byId.set(field.section, group); groups.push(group); }
    group.fields.push(field);
  }
  return { groups, files: payload?.files || null, allowActions };
}

// What a control shows for a value: booleans as words (never colour alone),
// an empty string as "(vazio)", everything else as text.
export function displayValue(field, value = field?.value) {
  if (value === null || value === undefined) return '(ausente)';
  if (field?.kind === 'boolean' || typeof value === 'boolean') return value ? 'ligado' : 'desligado';
  return value === '' ? '(vazio)' : String(value);
}

// The value the API receives from a control's raw input: a switch sends a
// boolean; every other control sends text and the server coerces and validates
// it by the key's kind (a bad number comes back as the schema's own refusal).
export function inputValue(field, raw) {
  if (field?.control === 'toggle') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  return raw === null || raw === undefined ? '' : String(raw);
}

// The control's initial state for a field: a boolean for a switch, text otherwise.
export function controlState(field) {
  if (field?.control === 'toggle') return field.value === true;
  return field?.value === null || field?.value === undefined ? '' : String(field.value);
}

export function writeRequest(field, scope, raw) {
  return { method: 'PUT', path: `/api/v1/settings/${encodeURIComponent(field.key)}`, body: { value: inputValue(field, raw), scope } };
}

export function unsetRequest(field, scope) {
  return { method: 'DELETE', path: `/api/v1/settings/${encodeURIComponent(field.key)}?scope=${encodeURIComponent(scope)}`, body: null };
}

// The line to show under a control after a write, from the API's answer.
export function changeNotice(change) {
  if (!change || typeof change !== 'object') return '';
  const scope = SCOPE_LABELS[change.scope] || change.scope || '';
  const where = `${scope}${change.path ? ` (${change.path})` : ''}`;
  let notice;
  if (change.to === null) {
    notice = change.changed ? `${change.key} removido de ${where}; era ${displayValue(null, change.from)}` : `${change.key} não estava definido em ${where}; nada mudou`;
  } else {
    notice = change.changed
      ? `${change.key} = ${displayValue(null, change.to)} gravado em ${where}${change.from === null || change.from === undefined ? '' : ` (era ${displayValue(null, change.from)})`}`
      : `${change.key} já era ${displayValue(null, change.to)} em ${where}; nada mudou`;
  }
  const effective = change.effective;
  if (effective && effective.source !== change.scope) notice += ` · valor efetivo agora: ${displayValue(null, effective.value)} (${sourceLabel(effective)})`;
  return notice;
}

// The message of a refusal: RFC 7807 `detail` first, then `title`, then the
// legacy `{ error }` shape, then the status alone.
export function problemMessage(body, status) {
  if (body && typeof body === 'object') {
    if (typeof body.detail === 'string' && body.detail) return body.detail;
    if (typeof body.title === 'string' && body.title) return body.title;
    if (typeof body.error === 'string' && body.error) return body.error;
  }
  return status ? `HTTP ${status}` : 'falhou';
}
