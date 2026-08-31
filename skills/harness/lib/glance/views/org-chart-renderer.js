/* org-chart-renderer.js — D3 v7 hierarchical org chart from Business
 * org-chart.yaml + employee frontmatter, replacing the earlier Mermaid
 * flowchart (owner request, 2026-08-31: wanted the "luxury" D3 org-chart
 * look already prototyped in a sibling project's render-org-charts.ts —
 * near-black/gold cards, orthogonal elbow connectors, one card per
 * employee with role badge / reports-to / description / DNA / squads).
 *
 * That prototype's own header comment: "Static inlining is a prototype...
 * Tomorrow those two functions become fetch() against the Glance URLs."
 * This IS that promotion — same tree-building and D3 layout logic, adapted
 * to render into an existing Glance tab pane (`#org-chart-canvas`) instead
 * of a standalone page, and fed by the real `detail` object
 * `GET /api/businesses/:slug` already returns (data-loader.ts's
 * getBusinessDetail() now also includes `employees_md`, the one field the
 * prototype had to fake).
 *
 * Theme-aware (owner feedback, 2026-08-31: "precisa manter as cores do
 * glance"): the prototype's fixed near-black/gold palette was replaced with
 * Glance's own tokens.css custom properties (--surface-*, --border-*,
 * --text-*, --accent, --status-danger-*), so the chart follows whichever
 * theme (light / apple-dark / awwwards) the user has active instead of
 * always rendering as a separate dark "poster".
 */
(function () {
  var STYLE_ID = 'orgd3-style';
  var CARD_W = 196;
  var CEO_W = 320;
  var H_GAP = 22;
  var V_GAP = 58;
  var PAD_X = 28;
  var PAD_Y = 16;
  var GENERIC_ROLE = { ceo: 1, director: 1, worker: 1, utility: 1, qa: 1 };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.orgd3-root{',
      '  background:var(--surface-1);border-radius:var(--radius-lg);position:relative;overflow:hidden;',
      '  font-family:var(--font-sans);',
      '}',
      '.orgd3-scroll{overflow:auto;padding:20px 16px;max-height:640px}',
      '.orgd3-fit{position:relative;width:100%}',
      '.orgd3-canvas{position:absolute;left:50%;top:0;transform-origin:top center}',
      '.orgd3-links{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}',
      '.orgd3-links path{fill:none;stroke:var(--border-strong);stroke-width:1.5;stroke-linejoin:miter;stroke-linecap:butt}',
      '.orgd3-nodes{position:relative;width:100%;height:100%}',
      '.orgd3-empty{text-align:center;color:var(--text-tertiary);padding:48px 16px;font-size:.9rem}',
      '.orgd3-node{position:absolute;background:var(--surface-2);border:1px solid var(--border-default);border-radius:var(--radius-md);',
      '  padding:16px 18px;text-align:center;display:flex;flex-direction:column;align-items:center;',
      '  justify-content:flex-start;transition:border-color .2s ease,box-shadow .2s ease}',
      '.orgd3-node:hover{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-soft)}',
      '.orgd3-node .role-tag{display:inline-block;font-size:.58rem;font-weight:900;letter-spacing:.18em;',
      '  text-transform:uppercase;padding:3px 10px;border-radius:var(--radius-pill);margin-bottom:8px;white-space:nowrap}',
      '.orgd3-tag-ceo{background:var(--accent);color:var(--accent-fg)}',
      '.orgd3-tag-director{background:transparent;border:1.5px solid var(--accent);color:var(--accent)}',
      '.orgd3-tag-qa{background:var(--status-danger-bg);color:var(--status-danger-fg);border:1px solid var(--status-danger-border)}',
      '.orgd3-tag-worker{background:var(--surface-3);border:1px solid var(--border-default);color:var(--text-tertiary)}',
      '.orgd3-node h3{font-size:.92rem;font-weight:700;letter-spacing:.02em;color:var(--text-primary);margin:0}',
      '.orgd3-node .who{font-size:.66rem;color:var(--text-tertiary);margin-top:4px;letter-spacing:.03em}',
      '.orgd3-node .what{font-size:.72rem;color:var(--text-secondary);margin-top:10px;line-height:1.4}',
      '.orgd3-node .dna{margin-top:10px;padding-top:8px;border-top:1px dashed var(--border-default);',
      '  font-size:.6rem;color:var(--text-tertiary);letter-spacing:.02em}',
      '.orgd3-node .sq{margin-top:8px;font-size:.58rem;letter-spacing:.06em;text-transform:uppercase;color:var(--text-tertiary)}',
      '.orgd3-node .sq b{color:var(--accent);font-weight:600}',
      '.orgd3-node-ceo{border-color:var(--accent);box-shadow:0 0 60px -20px var(--accent-soft)}',
      '.orgd3-node-ceo h3{font-size:1.05rem;text-transform:uppercase;letter-spacing:.1em}',
      '.orgd3-node-ceo:hover{box-shadow:0 0 60px -16px var(--accent-soft)}',
      '.orgd3-node-director{border-color:var(--accent)}',
      '.orgd3-node-qa{border:1px dashed var(--status-danger-border);background:var(--surface-2)}',
      '.orgd3-node-qa:hover{border-color:var(--status-danger-fg)}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function asList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    return [String(v)];
  }
  function stripMd(s) {
    return String(s || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function clip(s, n) {
    var t = String(s || '');
    if (t.length <= n) return t;
    return t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
  }
  function titleCase(s) {
    return String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function humanizeSlug(slug) {
    var parts = String(slug || '').split('-').filter(Boolean);
    if (parts.length > 1 && parts[0].length <= 3) parts = parts.slice(1);
    return parts.map(function (p) {
      if (p.toLowerCase() === 'ceo') return 'CEO';
      if (p.toLowerCase() === 'qa') return 'QA';
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join(' ');
  }
  function humanizeClone(s) {
    var base = String(s || '').split('/').pop();
    return titleCase(base);
  }
  function parseFrontmatter(md) {
    if (!md) return {};
    var m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
    if (!m) return {};
    try {
      var fm = window.jsyaml.load(m[1]);
      return fm && typeof fm === 'object' && !Array.isArray(fm) ? fm : {};
    } catch (e) { return {}; }
  }
  function displayName(slug, emp, orgNode) {
    var role = (emp && emp.role) || (orgNode && orgNode.orgRole) || '';
    var roleNorm = String(role).trim();
    var key = roleNorm.toLowerCase().replace(/\s+/g, '_');
    if (roleNorm && !GENERIC_ROLE[key]) return roleNorm;
    var desc = (emp && emp.description) || '';
    var bold = /\*\*([^*]{2,80})\*\*/.exec(desc);
    if (bold) return bold[1];
    if (key === 'ceo') return 'CEO';
    return humanizeSlug(slug);
  }
  function heartbeatWho(emp) {
    var hb = emp && emp.heartbeat;
    if (!hb || hb.enabled === false || !hb.cadence) return '';
    var map = { hourly: 'horário', daily: 'diário', weekly: 'semanal', manual: 'manual', 'on-demand': 'sob demanda' };
    return 'heartbeat ' + (map[hb.cadence] || hb.cadence);
  }

  function chartEntries(parsed) {
    if (!parsed || typeof parsed !== 'object') return [];
    if (Array.isArray(parsed.chart)) {
      return parsed.chart.filter(Boolean).map(function (n) {
        return {
          id: n.employee, reports: asList(n.reports), childrenIds: asList(n.direct_reports),
          is_antagonist: !!n.is_antagonist, orgRole: null, primary_mind_clones: null, primary_squads: null,
        };
      }).filter(function (n) { return !!n.id; });
    }
    if (parsed.org && typeof parsed.org === 'object' && !Array.isArray(parsed.org)) {
      return Object.keys(parsed.org).map(function (id) {
        var n = parsed.org[id] || {};
        var reportsTo = n.reports_to;
        return {
          id: id, reports: (reportsTo == null || reportsTo === '') ? [] : [reportsTo],
          childrenIds: asList(n.manages), is_antagonist: !!n.is_antagonist, orgRole: n.role || null,
          primary_mind_clones: asList(n.primary_mind_clones), primary_squads: asList(n.primary_squads),
        };
      });
    }
    return [];
  }

  function toCard(entry, emp, isRoot, nameOf) {
    var antagonist = !!(entry.is_antagonist || (emp && emp.is_antagonist));
    var manages = asList(emp && emp.manages);
    if (!manages.length) manages = entry.childrenIds || [];
    var tag, tagClass, kind;
    if (isRoot || (emp && emp.is_brief_intake)) { tag = 'CEO'; tagClass = 'orgd3-tag-ceo'; kind = 'orgd3-node-ceo'; }
    else if (antagonist) { tag = 'QA · antagonist'; tagClass = 'orgd3-tag-qa'; kind = 'orgd3-node-qa'; }
    else if (manages.length) { tag = 'Diretoria'; tagClass = 'orgd3-tag-director'; kind = 'orgd3-node-director'; }
    else { tag = 'Worker'; tagClass = 'orgd3-tag-worker'; kind = 'orgd3-node-worker'; }

    var who = '';
    if (isRoot || (emp && emp.is_brief_intake)) who = heartbeatWho(emp);
    else if (emp && emp.reports_to) who = 'reports to: ' + (nameOf(emp.reports_to) || emp.reports_to);
    else if (entry.reports && entry.reports[0]) who = 'reports to: ' + (nameOf(entry.reports[0]) || entry.reports[0]);

    var what = clip(stripMd(emp && emp.description ? emp.description : ''), 220);
    var dnaSrc = asList(emp && (emp.assigned_mind_clones || emp.mind_clones_used));
    if (!dnaSrc.length) dnaSrc = asList(entry.primary_mind_clones);
    var dna = dnaSrc.map(humanizeClone).filter(Boolean).join(' + ');
    var squads = asList(emp && (emp.squads_authorized || emp.squad_dispatched));
    if (!squads.length) squads = asList(entry.primary_squads);

    return { id: entry.id, name: displayName(entry.id, emp, entry), tag: tag, tagClass: tagClass, kind: kind,
      who: who, what: what, dna: dna, squads: squads, children: [] };
  }

  function buildHierarchy(entries, empMap) {
    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });
    var childSet = {};
    entries.forEach(function (e) { (e.childrenIds || []).forEach(function (c) { childSet[c] = true; }); });
    var roots = entries.filter(function (e) { return (!e.reports || e.reports.length === 0) && !childSet[e.id]; });
    if (!roots.length) roots = entries.filter(function (e) { return !e.reports || e.reports.length === 0; });
    if (!roots.length && entries.length) roots = [entries[0]];
    if (!roots.length) return null;

    var names = {};
    function nameOf(id) {
      if (names[id]) return names[id];
      names[id] = displayName(id, empMap[id], byId[id]);
      return names[id];
    }
    entries.forEach(function (e) { nameOf(e.id); });

    var visiting = {};
    function nodeFrom(entry, isRoot) {
      if (!entry || visiting[entry.id]) return null;
      visiting[entry.id] = true;
      var card = toCard(entry, empMap[entry.id] || {}, isRoot, nameOf);
      var kids = [];
      (entry.childrenIds || []).forEach(function (cid) {
        var child = byId[cid];
        if (!child) {
          child = { id: cid, reports: [entry.id], childrenIds: asList(empMap[cid] && empMap[cid].manages),
            is_antagonist: !!(empMap[cid] && empMap[cid].is_antagonist), orgRole: empMap[cid] && empMap[cid].role,
            primary_mind_clones: null, primary_squads: null };
        }
        var n = nodeFrom(child, false);
        if (n) kids.push(n);
      });
      visiting[entry.id] = false;
      card.children = kids;
      return card;
    }
    return nodeFrom(roots[0], true);
  }

  function squadHtml(d) {
    if (!d.squads || !d.squads.length) return '';
    var label = d.squads.length > 1 ? 'Squads → ' : 'Squad → ';
    var names = d.squads.map(function (s) { return '<b>' + esc(s) + '</b>'; }).join(' · ');
    return label + names;
  }
  function createCard(d) {
    var art = document.createElement('article');
    art.className = 'orgd3-node' + (d.kind ? ' ' + d.kind : '');
    art.setAttribute('data-employee', d.id);
    var html = '<span class="role-tag ' + esc(d.tagClass) + '">' + esc(d.tag) + '</span>';
    html += '<h3>' + esc(d.name) + '</h3>';
    if (d.who) html += '<div class="who">' + esc(d.who) + '</div>';
    if (d.what) html += '<p class="what">' + esc(d.what) + '</p>';
    if (d.dna) html += '<div class="dna">DNA: ' + esc(d.dna) + '</div>';
    var sq = squadHtml(d);
    if (sq) html += '<div class="sq">' + sq + '</div>';
    art.innerHTML = html;
    return art;
  }
  function elbow(source, target) {
    var x1 = source.x, y1 = source.yBottom, x2 = target.x, y2 = target.y;
    var mid = (y1 + y2) / 2;
    return 'M' + x1 + ' ' + y1 + ' V' + mid + ' H' + x2 + ' V' + y2;
  }

  function renderTree(refs, tree) {
    refs.nodesLayer.innerHTML = '';
    refs.svg.selectAll('*').remove();

    if (!tree) {
      refs.canvas.style.width = '100%';
      refs.canvas.style.height = 'auto';
      refs.canvas.style.transform = 'none';
      refs.canvas.style.marginLeft = '0';
      refs.canvas.style.left = '0';
      refs.fitEl.style.height = 'auto';
      var empty = document.createElement('p');
      empty.className = 'orgd3-empty';
      empty.textContent = 'Sem organograma para esta empresa.';
      refs.nodesLayer.appendChild(empty);
      return;
    }

    refs.canvas.style.left = '50%';
    var root = d3.hierarchy(tree);
    var dx = CARD_W + H_GAP;
    var dy = 240;
    d3.tree().nodeSize([dx, dy]).separation(function (a, b) { return a.parent === b.parent ? 1 : 1.18; })(root);

    var nodes = root.descendants();
    var links = root.links();

    nodes.forEach(function (n) {
      var el = createCard(n.data);
      var w = n.depth === 0 ? CEO_W : CARD_W;
      el.style.width = w + 'px';
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.visibility = 'hidden';
      refs.nodesLayer.appendChild(el);
      n.el = el;
      n.cardW = el.offsetWidth;
      n.cardH = el.offsetHeight;
    });

    var maxH = [];
    nodes.forEach(function (n) { maxH[n.depth] = Math.max(maxH[n.depth] || 0, n.cardH); });
    var yOf = [];
    yOf[0] = PAD_Y;
    var maxDepth = d3.max(nodes, function (n) { return n.depth; });
    for (var i = 1; i <= maxDepth; i++) yOf[i] = yOf[i - 1] + maxH[i - 1] + V_GAP;

    nodes.forEach(function (n) {
      n.y = yOf[n.depth];
      n.el.style.height = maxH[n.depth] + 'px';
      n.cardH = maxH[n.depth];
    });

    var minLeft = d3.min(nodes, function (n) { return n.x - n.cardW / 2; });
    var maxRight = d3.max(nodes, function (n) { return n.x + n.cardW / 2; });
    var treeW = maxRight - minLeft;
    var canvasW = Math.ceil(treeW + PAD_X * 2);
    var xShift = (canvasW - treeW) / 2 - minLeft;
    var canvasH = Math.ceil(yOf[maxDepth] + maxH[maxDepth] + PAD_Y);

    nodes.forEach(function (n) {
      n.x = n.x + xShift;
      n.yBottom = n.y + n.cardH;
      n.el.style.visibility = 'visible';
      n.el.style.left = (n.x - n.cardW / 2) + 'px';
      n.el.style.top = n.y + 'px';
    });

    refs.canvas.style.width = canvasW + 'px';
    refs.canvas.style.height = canvasH + 'px';
    refs.canvas.style.marginLeft = (-canvasW / 2) + 'px';

    refs.svg.attr('width', canvasW).attr('height', canvasH).attr('viewBox', '0 0 ' + canvasW + ' ' + canvasH);
    refs.svg.selectAll('path').data(links).join('path').attr('d', function (d) { return elbow(d.source, d.target); });

    var fitW = Math.max(refs.fitEl.clientWidth || refs.scrollEl.clientWidth || 0, 320);
    var scale = canvasW > fitW ? (fitW / canvasW) : 1;
    refs.canvas.style.transform = 'scale(' + scale + ')';
    refs.fitEl.style.height = Math.ceil(canvasH * scale) + 'px';
  }

  /** window.renderOrgChart(selector, detail) — `detail` is the object
   *  GET /api/businesses/:slug returns (org_chart_raw, employees_md,
   *  manifest_raw...). Kept as the SAME global function name/call site
   *  glance.js already uses; only the second argument's shape changed
   *  (used to be the bare org_chart_raw string). */
  window.renderOrgChart = function (selector, detail) {
    var container = document.querySelector(selector);
    if (!container) return;
    container.innerHTML = '';

    if (!detail || !detail.org_chart_raw) {
      container.innerHTML = '<div class="org-empty">No org-chart.yaml in this business</div>';
      return;
    }
    if (typeof d3 === 'undefined' || !window.jsyaml) {
      container.innerHTML = '<div class="org-empty">Loading d3/js-yaml… (refresh if persists)</div>';
      setTimeout(function () { window.renderOrgChart(selector, detail); }, 400);
      return;
    }

    var chart;
    try { chart = window.jsyaml.load(detail.org_chart_raw); }
    catch (e) {
      container.innerHTML = '<div class="org-empty">YAML parse error: ' + esc(e.message) + '</div>';
      return;
    }

    ensureStyle();
    container.classList.add('orgd3-root');
    container.innerHTML =
      '<div class="orgd3-scroll" tabindex="0" aria-label="Organograma">' +
        '<div class="orgd3-fit">' +
          '<div class="orgd3-canvas">' +
            '<svg class="orgd3-links" aria-hidden="true"></svg>' +
            '<div class="orgd3-nodes"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var refs = {
      scrollEl: container.querySelector('.orgd3-scroll'),
      fitEl: container.querySelector('.orgd3-fit'),
      canvas: container.querySelector('.orgd3-canvas'),
      nodesLayer: container.querySelector('.orgd3-nodes'),
      svg: d3.select(container.querySelector('.orgd3-links')),
    };

    var empMap = {};
    var md = detail.employees_md || {};
    Object.keys(md).forEach(function (id) { empMap[id] = parseFrontmatter(md[id]); });

    var entries = chartEntries(chart);
    if (!entries.length) {
      container.innerHTML = '<div class="org-empty">No employees in org-chart</div>';
      return;
    }
    var tree = buildHierarchy(entries, empMap);
    renderTree(refs, tree);

    var resizeTimer = null;
    var onResize = function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { renderTree(refs, tree); }, 150);
    };
    if (container._orgd3Resize) window.removeEventListener('resize', container._orgd3Resize);
    container._orgd3Resize = onResize;
    window.addEventListener('resize', onResize);
  };
})();
