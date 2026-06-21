/* dag-renderer.js — D3 force-directed DAG with status coloring + zoom/pan */
window.renderDag = function (selector, dag) {
  if (!dag || !window.d3) return;
  const container = document.querySelector(selector);
  if (!container) return;
  container.innerHTML = '';

  // Normalize: dag may be {nodes:[], edges:[]} or {steps:{...}, dependencies:{...}} (Maestro plan-architect)
  const nodes = [];
  const links = [];
  if (dag.nodes && dag.edges) {
    nodes.push(...dag.nodes.map(n => ({ id: n.id || n.slug, status: n.status || 'pending', label: n.label || n.id, ...n })));
    links.push(...dag.edges.map(e => ({ source: e.from || e.source, target: e.to || e.target })));
  } else if (dag.steps) {
    Object.entries(dag.steps).forEach(([id, s]) => nodes.push({ id, status: s.status || 'pending', label: s.label || id }));
    Object.entries(dag.dependencies || {}).forEach(([id, deps]) => (deps || []).forEach(d => links.push({ source: d, target: id })));
  } else if (Array.isArray(dag.waves)) {
    dag.waves.forEach((wave, wi) => {
      (wave.tasks || []).forEach(t => nodes.push({ id: t.id || t.slug, status: t.status || 'pending', label: t.label || t.id, _wave: wi }));
      (wave.tasks || []).forEach(t => (t.depends_on || []).forEach(d => links.push({ source: d, target: t.id || t.slug })));
    });
  }

  if (nodes.length === 0) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--fg-subtle);font-size:13px">No DAG data yet — project may not have run.</div>`;
    return;
  }

  const width = container.clientWidth;
  const height = container.clientHeight;
  const svg = d3.select(container).append('svg').attr('viewBox', [0, 0, width, height]);
  const g = svg.append('g');

  svg.call(d3.zoom().scaleExtent([0.3, 4]).on('zoom', (e) => g.attr('transform', e.transform)));

  // Arrowhead
  svg.append('defs').append('marker')
    .attr('id', 'arrow').attr('viewBox', '0 -5 10 10').attr('refX', 18).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', 'currentColor').attr('opacity', 0.5);

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-220))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(28));

  const link = g.selectAll('.dag-link').data(links).join('path').attr('class', 'dag-link').attr('marker-end', 'url(#arrow)');

  const node = g.selectAll('.dag-node').data(nodes, d => d.id).join('g')
    .attr('class', d => `dag-node node-${d.status}`)
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append('circle').attr('r', 14);
  node.append('text').attr('text-anchor', 'middle').attr('dy', 28).text(d => (d.label || d.id || '').slice(0, 16));
  node.append('title').text(d => `${d.id}\nstatus: ${d.status}`);

  sim.on('tick', () => {
    link.attr('d', d => {
      const s = d.source, t = d.target;
      return `M${s.x},${s.y} L${t.x},${t.y}`;
    });
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
};
