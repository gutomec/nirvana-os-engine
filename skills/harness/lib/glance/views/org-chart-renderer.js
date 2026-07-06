/* org-chart-renderer.js — Mermaid flowchart from Business org-chart YAML.
 * Renders a clean hierarchical chart with theme-aware colors and pan/zoom.
 * Falls back to a clear "no data" message rather than blank canvas.
 */
window.renderOrgChart = async function (selector, yamlRaw) {
  const container = document.querySelector(selector);
  if (!container) return;
  container.innerHTML = '';

  if (!yamlRaw) {
    container.innerHTML = `<div class="org-empty">No org-chart.yaml in this business</div>`;
    return;
  }
  if (!window.mermaid) {
    container.innerHTML = `<div class="org-empty">Loading mermaid… (refresh if persists)</div>`;
    setTimeout(() => window.renderOrgChart(selector, yamlRaw), 800);
    return;
  }

  let parsed;
  try { parsed = window.jsyaml.load(yamlRaw); }
  catch (e) {
    container.innerHTML = `<div class="org-empty">YAML parse error: ${e.message}</div>`;
    return;
  }

  const entries = parsed?.chart || parsed?.org_chart || parsed?.employees || (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(entries) || entries.length === 0) {
    container.innerHTML = `<div class="org-empty">No employees in org-chart</div>`;
    return;
  }

  // Build node + edge sets
  const known = new Set();
  const edges = [];
  for (const e of entries) {
    if (!e || !e.employee) continue;
    known.add(e.employee);
    for (const child of (e.direct_reports || [])) {
      edges.push([e.employee, child]);
      known.add(child);
    }
  }
  if (known.size === 0) {
    container.innerHTML = `<div class="org-empty">No employees referenced</div>`;
    return;
  }

  // Identify root(s): no `reports` OR not in any direct_reports list
  const isChild = new Set(edges.map(e => e[1]));
  const roots = [];
  for (const e of entries) {
    if (!e?.employee) continue;
    if ((!e.reports || e.reports.length === 0) && !isChild.has(e.employee)) roots.push(e.employee);
  }

  // Theme-aware mermaid config
  const theme = document.documentElement.dataset.theme || 'apple';
  const themeMap = {
    'apple':       { mermaidTheme: 'default',     primary: '#3B82F6', text: '#1F2937', bg: '#FFFFFF', edgeColor: '#9CA3AF' },
    'apple-dark':  { mermaidTheme: 'dark',        primary: '#3B82F6', text: '#F3F4F6', bg: '#18181B', edgeColor: '#6B7280' },
    'awwwards':    { mermaidTheme: 'dark',        primary: '#A3E635', text: '#F4F4F5', bg: '#0A0A0A', edgeColor: '#52525B' },
  };
  const tk = themeMap[theme] || themeMap.apple;

  // Build mermaid syntax: `flowchart TD`
  const safeId = (s) => 'n_' + s.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines = [
    `%%{init: {'theme': '${tk.mermaidTheme}', 'themeVariables': { 'primaryColor': '${tk.primary}', 'primaryTextColor': '${tk.text}', 'lineColor': '${tk.edgeColor}', 'fontSize': '13px', 'fontFamily': 'Inter, sans-serif' } }}%%`,
    'flowchart TD',
  ];
  for (const name of known) {
    const id = safeId(name);
    const isRoot = roots.includes(name);
    const label = name.length > 28 ? name.slice(0, 26) + '…' : name;
    lines.push(`  ${id}["${label}"]${isRoot ? ':::ceo' : ''}`);
  }
  for (const [parent, child] of edges) {
    lines.push(`  ${safeId(parent)} --> ${safeId(child)}`);
  }
  lines.push(`  classDef ceo fill:${tk.primary},stroke:${tk.primary},color:${theme === 'awwwards' ? '#0A0A0A' : '#FFFFFF'},font-weight:700,stroke-width:2px;`);

  const code = lines.join('\n');

  // Render
  const id = `org-chart-${Date.now()}`;
  try {
    const { svg } = await window.mermaid.render(id, code);
    container.innerHTML = svg;

    // Make svg responsive + add pan/zoom
    const svgEl = container.querySelector('svg');
    if (svgEl) {
      svgEl.style.maxWidth = '100%';
      svgEl.style.height = '480px';
      svgEl.style.background = tk.bg;
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      // Hook up svg-pan-zoom for smooth interaction
      if (window.svgPanZoom) {
        try {
          window.svgPanZoom(svgEl, {
            zoomEnabled: true, controlIconsEnabled: false, fit: true, center: true,
            minZoom: 0.4, maxZoom: 4, contain: true,
          });
        } catch (e) { /* graceful */ }
      }
    }
  } catch (e) {
    container.innerHTML = `<div class="org-empty">Render error: ${e.message}<pre style="text-align:left;font-size:11px;margin-top:12px;color:var(--fg-subtle);max-height:200px;overflow:auto">${code}</pre></div>`;
  }
};
