/* graph-renderer.js — D3 force-directed knowledge graph for Glance.
 *
 * Renders nodes (squads/businesses/mind-clones/capabilities/decisions/artifacts)
 * and edges (typed by relation kind) with theme-aware coloring, score-sized
 * circles, hover-highlight neighbors, click-to-select, drag, zoom/pan, and
 * runtime-configurable physics (Obsidian-style settings popover).
 *
 * Public:
 *   const ctrl = window.renderGraph(selector, graph, opts);
 *
 * opts:
 *   filter:        'all' | 'capabilities' | 'created' | 'squads' | 'businesses' | 'mind-clones' | 'red-yellow'
 *   timeFilterISO: ISO timestamp; only nodes with created_at <= ts (or no created_at) are shown
 *   physics:       { linkDistance, charge, collide, alphaDecay, nodeScale, labelOpacity }
 *   colors:        { [type]: '#hex' }   // per-type override (otherwise uses defaults)
 *   onNodeSelect:  (node) => void       // called on click; pass null to deselect
 *   selectedId:    initial selected node id
 *
 * ctrl methods (returned object):
 *   updatePhysics(physics) — live-tune the simulation without a full redraw
 *   updateColors(colors)   — restyle nodes
 *   select(id)             — programmatically select a node (and pan-to-center it)
 *   centerOn(id)           — pan/zoom to a node without selecting
 *   resetView()            — fit-to-viewport
 *   dispose()              — stop simulation, remove DOM, free listeners
 */

(function () {
  // ── default colors (kept identical to legend in index.html) ────────────
  const DEFAULT_COLORS = {
    squad:        "#2563eb",
    business:     "#a855f7",
    "mind-clone": "#10b981",
    capability:   "#f59e0b",
    project:      "#dc2626",
    brief:        "#fb923c",
    plan:         "#eab308",
    dag:          "#84cc16",
    handoff:      "#06b6d4",
    audit_run:    "#8b5cf6",
    output:       "#14b8a6",
    decision:     "#ec4899",
  };
  const ARTIFACT_TYPES = new Set(["project", "brief", "plan", "dag", "handoff", "audit_run", "output", "decision"]);
  const TIER_BORDER = { green: "#10b981", yellow: "#f59e0b", red: "#ef4444" };

  const EDGE_STYLES = {
    "exposes":     { stroke: "#3b82f6", dasharray: "4,3",  width: 1.4 },
    "routes-via":  { stroke: "#8b5cf6", dasharray: null,   width: 2.0 },
    "uses-mc":     { stroke: "#10b981", dasharray: "1,3",  width: 1.4 },
    "produced":    { stroke: "#ef4444", dasharray: null,   width: 1.6 },
    "produced-by": { stroke: "#06b6d4", dasharray: "3,3",  width: 1.4 },
    "led-to":      { stroke: "#f59e0b", dasharray: "5,3",  width: 1.6 },
    "decided-in":  { stroke: "#ec4899", dasharray: "2,2",  width: 1.2 },
  };
  const DEFAULT_EDGE = { stroke: "#94a3b8", dasharray: null, width: 1 };
  function edgeStyle(kind) { return EDGE_STYLES[kind] || DEFAULT_EDGE; }

  // ── physics defaults (tuned for tighter clustering than v1) ────────────
  const DEFAULT_PHYSICS = {
    linkDistance: 36,    // shorter → tighter clusters
    charge:       -120,  // less negative → less repulsion → groups stay near
    collide:       3,    // padding around each node circle
    alphaDecay:    0.02, // lower → simulation runs longer → settles cleaner
    nodeScale:     1.0,  // multiplier on radiusFor()
    labelOpacity:  0.7,
  };

  function radiusFor(node, scale = 1) {
    let r;
    if (node.type === "capability") r = 4;
    else if (node.type === "decision") r = 5;
    else if (typeof node.score === "number") r = 7 + Math.min(8, Math.round(node.score / 12));
    else r = 8;
    return r * scale;
  }

  function applyFilter(graph, filter, opts) {
    let nodes = graph.nodes.slice();
    if (filter === "capabilities")        nodes = nodes.filter(n => !ARTIFACT_TYPES.has(n.type));
    else if (filter === "created")        nodes = nodes.filter(n =>  ARTIFACT_TYPES.has(n.type));
    else if (filter === "squads")         nodes = nodes.filter(n => n.type === "squad" || n.type === "capability");
    else if (filter === "businesses")     nodes = nodes.filter(n => n.type === "business" || n.type === "squad");
    else if (filter === "mind-clones")    nodes = nodes.filter(n => n.type === "mind-clone" || n.type === "business");
    else if (filter === "red-yellow")     nodes = nodes.filter(n => n.tier === "red" || n.tier === "yellow" || n.type === "capability");
    if (opts?.timeFilterISO) {
      const cutoff = opts.timeFilterISO;
      nodes = nodes.filter(n => !n.created_at || n.created_at <= cutoff);
    }
    const ids = new Set(nodes.map(n => n.id));
    const edges = graph.edges.filter(e => ids.has(e.source.id || e.source) && ids.has(e.target.id || e.target));
    return { nodes, edges };
  }

  window.renderGraph = function (selector, graph, opts = {}) {
    const container = typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!container || !window.d3 || !graph) return null;
    const d3 = window.d3;

    container.innerHTML = "";

    const colors  = Object.assign({}, DEFAULT_COLORS, opts.colors || {});
    const physics = Object.assign({}, DEFAULT_PHYSICS, opts.physics || {});
    let selectedId = opts.selectedId || null;

    const width  = container.clientWidth  || 800;
    const height = container.clientHeight || 600;

    const filtered = applyFilter(graph, opts.filter, { timeFilterISO: opts.timeFilterISO });

    const svg = d3.select(container)
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("display", "block")
      .style("width", "100%")
      .style("height", "100%");

    // Tooltip
    const tip = d3.select(container).append("div").attr("class", "graph-tooltip").style("display", "none");

    // Zoom container — wider scaleExtent so user can pan way out
    const root = svg.append("g").attr("class", "graph-root");
    const zoom = d3.zoom().scaleExtent([0.05, 8]).on("zoom", (evt) => {
      root.attr("transform", evt.transform);
      currentTransform = evt.transform;
    });
    svg.call(zoom);
    let currentTransform = d3.zoomIdentity;

    // Edges
    const linkGroup = root.append("g").attr("class", "edges");
    let link = linkGroup.selectAll("line").data(filtered.edges).enter().append("line")
      .attr("class", d => `edge edge-${d.kind || "default"}`)
      .attr("stroke", d => edgeStyle(d.kind).stroke)
      .attr("stroke-dasharray", d => edgeStyle(d.kind).dasharray)
      .attr("stroke-width", d => edgeStyle(d.kind).width)
      .attr("stroke-opacity", 0.55);

    // Nodes
    const nodeGroup = root.append("g").attr("class", "nodes");
    let node = nodeGroup.selectAll("g").data(filtered.nodes).enter().append("g")
      .attr("class", "node")
      .style("cursor", "pointer");

    let circle = node.append("circle")
      .attr("r", d => radiusFor(d, physics.nodeScale))
      .attr("fill", d => colors[d.type] || "#64748b")
      .attr("stroke", d => TIER_BORDER[d.tier] || "rgba(255,255,255,0.4)")
      .attr("stroke-width", d => d.tier ? 2 : 1);

    let label = node.append("text")
      .attr("class", "graph-label")
      .attr("dx", d => radiusFor(d, physics.nodeScale) + 4)
      .attr("dy", "0.32em")
      .text(d => d.label || d.slug || d.id)
      .attr("fill", "currentColor")
      .attr("font-size", 10)
      .attr("opacity", physics.labelOpacity);

    // Adjacency for hover highlight
    const adj = new Map();
    for (const e of filtered.edges) {
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s).add(t); adj.get(t).add(s);
    }

    function applySelection(id) {
      selectedId = id;
      circle
        .attr("stroke", d => {
          if (id && d.id === id) return "#ffffff";
          return TIER_BORDER[d.tier] || "rgba(255,255,255,0.4)";
        })
        .attr("stroke-width", d => {
          if (id && d.id === id) return 3.5;
          return d.tier ? 2 : 1;
        });
      // Dim non-neighbors when something is selected
      if (id) {
        const neighbors = adj.get(id) || new Set();
        node.style("opacity", n => (n.id === id || neighbors.has(n.id)) ? 1 : 0.18);
        link.style("stroke-opacity", e => {
          const s = e.source.id || e.source, t = e.target.id || e.target;
          return (s === id || t === id) ? 0.85 : 0.06;
        });
      } else {
        node.style("opacity", 1);
        link.style("stroke-opacity", 0.55);
      }
    }

    node
      .on("mouseenter", function (evt, d) {
        if (selectedId) return; // selection takes precedence
        const neighbors = adj.get(d.id) || new Set();
        node.style("opacity", n => (n.id === d.id || neighbors.has(n.id)) ? 1 : 0.18);
        link.style("stroke-opacity", e => {
          const s = e.source.id || e.source, t = e.target.id || e.target;
          return (s === d.id || t === d.id) ? 0.85 : 0.06;
        });
        const r = container.getBoundingClientRect();
        const parts = [`${d.type} · ${d.label || d.slug || d.id}`];
        if (d.tier) parts.push(d.tier);
        if (typeof d.score === "number") parts.push(`score ${d.score}`);
        if (d.created_at) parts.push(`@ ${d.created_at.slice(0, 16)}`);
        tip
          .style("display", "block")
          .style("left", (evt.clientX - r.left + 8) + "px")
          .style("top", (evt.clientY - r.top + 8) + "px")
          .text(parts.join(" · "));
      })
      .on("mouseleave", function () {
        if (selectedId) return;
        node.style("opacity", 1);
        link.style("stroke-opacity", 0.55);
        tip.style("display", "none");
      })
      .on("click", function (evt, d) {
        evt.stopPropagation();
        // Toggle selection: clicking the selected node deselects
        const newId = (selectedId === d.id) ? null : d.id;
        applySelection(newId);
        if (opts.onNodeSelect) opts.onNodeSelect(newId ? d : null);
      });
    // Click empty canvas to deselect
    svg.on("click", function () {
      if (!selectedId) return;
      applySelection(null);
      if (opts.onNodeSelect) opts.onNodeSelect(null);
    });

    // Force simulation
    const sim = d3.forceSimulation(filtered.nodes)
      .force("link", d3.forceLink(filtered.edges).id(d => d.id).distance(physics.linkDistance).strength(0.6))
      .force("charge", d3.forceManyBody().strength(physics.charge))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius(d => radiusFor(d, physics.nodeScale) + physics.collide))
      .alphaDecay(physics.alphaDecay);

    sim.on("tick", () => {
      link
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    // Drag
    node.call(d3.drag()
      .on("start", (evt, d) => { if (!evt.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (evt, d) => { d.fx = evt.x; d.fy = evt.y; })
      .on("end", (evt, d) => { if (!evt.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    // Apply initial selection if requested
    if (selectedId) applySelection(selectedId);

    // ── controller API ────────────────────────────────────────────────────
    const ctrl = {
      updatePhysics(p) {
        Object.assign(physics, p);
        sim.force("link").distance(physics.linkDistance);
        sim.force("charge").strength(physics.charge);
        sim.force("collide").radius(d => radiusFor(d, physics.nodeScale) + physics.collide);
        sim.alphaDecay(physics.alphaDecay);
        circle.attr("r", d => radiusFor(d, physics.nodeScale));
        label
          .attr("dx", d => radiusFor(d, physics.nodeScale) + 4)
          .attr("opacity", physics.labelOpacity);
        sim.alpha(0.5).restart();
      },
      updateColors(c) {
        Object.assign(colors, c);
        circle.attr("fill", d => colors[d.type] || "#64748b");
      },
      select(id) {
        applySelection(id || null);
        if (id) ctrl.centerOn(id);
      },
      centerOn(id) {
        const target = filtered.nodes.find(n => n.id === id);
        if (!target || target.x == null) return;
        const k = currentTransform.k || 1.2;
        const tx = width / 2 - target.x * k;
        const ty = height / 2 - target.y * k;
        svg.transition().duration(450)
          .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      },
      resetView() {
        svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity);
      },
      // Auto-zoom to fit all visible nodes within the viewport (with padding).
      // Called by Glance when the filter changes so the user instantly sees
      // every node in the chosen category, regardless of cluster size.
      fitToExtent(padding = 60) {
        // Wait one tick if the simulation hasn't placed nodes yet
        const placed = filtered.nodes.filter(n => n.x != null && n.y != null);
        if (placed.length === 0) {
          setTimeout(() => ctrl.fitToExtent(padding), 100);
          return;
        }
        let minX =  Infinity, minY =  Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        for (const n of placed) {
          const r = radiusFor(n, physics.nodeScale);
          if (n.x - r < minX) minX = n.x - r;
          if (n.y - r < minY) minY = n.y - r;
          if (n.x + r > maxX) maxX = n.x + r;
          if (n.y + r > maxY) maxY = n.y + r;
        }
        const w = Math.max(maxX - minX, 1);
        const h = Math.max(maxY - minY, 1);
        const k = Math.min(
          (width  - padding * 2) / w,
          (height - padding * 2) / h,
          4   // never zoom in more than 4x via auto-fit (would be jarring)
        );
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const tx = width  / 2 - cx * k;
        const ty = height / 2 - cy * k;
        svg.transition().duration(550)
          .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      },
      dispose() {
        sim.stop();
        svg.on(".zoom", null);
        svg.remove();
        tip.remove();
      },
    };
    return ctrl;
  };
})();
