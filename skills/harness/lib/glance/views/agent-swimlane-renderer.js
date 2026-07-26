/* agent-swimlane-renderer.js — D3 mini-timeline per agent card.
 *
 * Renders the last ~60 seconds of recent_events as colored segments
 * along a horizontal lane. Used in the Agents tab for live visualization.
 *
 * API:
 *   window.renderAgentSwimlane(svgEl, events, opts?)
 *
 * Where:
 *   svgEl  — an <svg> element to render into
 *   events — Array<{ts, event, meta?}> (newest last)
 *   opts   — { windowMs?: number (default 60000), height?: number (default 36) }
 */
(function () {
  if (!window.d3) {
    console.warn('[agent-swimlane] d3 not loaded; swimlane will be inactive');
  }

  const COLORS = {
    tool_invoked: '#facc15',         // amber-400 (active)
    artifact_touched: '#22c55e',     // green-500 (created/modified)
    bash_completed: '#06b6d4',       // cyan-500
    cost_emission: '#a78bfa',        // violet-400 (token burn)
    gate_passed: '#10b981',          // emerald-500
    gate_failed: '#ef4444',          // red-500
    delivered: '#3b82f6',            // blue-500 (final)
    revision: '#f59e0b',             // amber-500
    routing_decision: '#8b5cf6',     // violet-500
    dispatch_squad: '#ec4899',       // pink-500
    brief_received: '#94a3b8',       // slate-400
    brief_amplified: '#94a3b8',
    session_started: '#64748b',      // slate-500
    local_execution_started: '#0ea5e9',  // sky-500
    local_execution_completed: '#0284c7',  // sky-600
    target_plan_committed: '#7c3aed',
    humanize_completed: '#a78bfa',
    context_budget_warning: '#f97316',  // orange-500
    no_match: '#6b7280',             // gray-500
  };

  function colorFor(event) {
    return COLORS[event] || '#475569';  // slate-600 default
  }

  function shortDescription(ev) {
    if (!ev) return '';
    const meta = ev.meta || {};
    if (ev.event === 'tool_invoked') return `${meta.action || 'tool'}: ${meta.file ? meta.file.split('/').pop() : ''}`;
    if (ev.event === 'artifact_touched') return `${meta.action || 'edit'}: ${meta.file ? meta.file.split('/').pop() : ''}`;
    if (ev.event === 'bash_completed') return `bash${meta.success === false ? ' (failed)' : ''}: ${meta.command || ''}`;
    if (ev.event === 'cost_emission') return `${meta.tokens || 0} tokens · ${meta.model || ''}`;
    if (ev.event === 'gate_passed') return 'gate passed';
    if (ev.event === 'gate_failed') return 'gate failed';
    if (ev.event === 'delivered') return `delivered: ${(meta.artifact || '').split('/').pop()}`;
    return ev.event.replace(/_/g, ' ');
  }

  window.renderAgentSwimlane = function (svgEl, events, opts) {
    if (!svgEl || !window.d3) return;
    const d3 = window.d3;
    const o = opts || {};
    const windowMs = o.windowMs || 60_000;
    const height = o.height || 36;
    const padding = { top: 4, right: 8, bottom: 4, left: 8 };

    // Wipe + redraw
    const sel = d3.select(svgEl);
    sel.selectAll('*').remove();

    const rect = svgEl.getBoundingClientRect();
    const width = Math.max(120, rect.width || svgEl.clientWidth || 400);
    sel.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;

    const now = Date.now();
    const t0 = now - windowMs;
    const xScale = d3.scaleLinear().domain([t0, now]).range([0, innerW]).clamp(true);

    const g = sel.append('g').attr('transform', `translate(${padding.left},${padding.top})`);

    // Background lane
    g.append('rect')
      .attr('x', 0)
      .attr('y', innerH / 2 - 1)
      .attr('width', innerW)
      .attr('height', 2)
      .attr('fill', 'rgba(148, 163, 184, 0.15)');

    // Time-window grid: tick at -50, -40, ..., -10
    [50, 40, 30, 20, 10].forEach(s => {
      const x = xScale(now - s * 1000);
      g.append('line')
        .attr('x1', x).attr('x2', x)
        .attr('y1', innerH / 2 - 4).attr('y2', innerH / 2 + 4)
        .attr('stroke', 'rgba(148, 163, 184, 0.2)')
        .attr('stroke-width', 1);
    });

    // Filter events to window
    const inWindow = (events || []).filter(e => {
      try { return new Date(e.ts).getTime() >= t0; } catch { return false; }
    });

    // Draw event markers
    const tip = svgEl._tip || (svgEl._tip = (() => {
      const t = document.createElement('div');
      t.style.cssText = 'position:absolute;background:#0f1219;color:#e2e8f0;border:1px solid #334155;padding:4px 8px;font-size:10px;border-radius:4px;pointer-events:none;display:none;z-index:9999;white-space:nowrap;font-family:system-ui';
      document.body.appendChild(t);
      return t;
    })());

    g.selectAll('rect.event-marker')
      .data(inWindow)
      .enter()
      .append('rect')
      .attr('class', 'event-marker')
      .attr('x', d => xScale(new Date(d.ts).getTime()) - 1.5)
      .attr('y', d => {
        // small markers above the lane for token emissions; below for tool/artifact
        if (d.event === 'cost_emission') return innerH / 2 - 8;
        if (d.event === 'gate_passed' || d.event === 'gate_failed' || d.event === 'delivered') return innerH / 2 - 10;
        return innerH / 2 - 4;
      })
      .attr('width', d => (d.event === 'delivered' || d.event === 'gate_passed' || d.event === 'gate_failed') ? 4 : 3)
      .attr('height', d => {
        if (d.event === 'cost_emission') return 6;
        if (d.event === 'delivered' || d.event === 'gate_passed' || d.event === 'gate_failed') return 12;
        return 8;
      })
      .attr('rx', 1)
      .attr('fill', d => colorFor(d.event))
      .style('cursor', 'pointer')
      .on('mouseenter', function (e, d) {
        tip.textContent = `${shortDescription(d)} · ${new Date(d.ts).toLocaleTimeString()}`;
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 10) + 'px';
        tip.style.top = (e.clientY + 10) + 'px';
      })
      .on('mousemove', function (e) {
        tip.style.left = (e.clientX + 10) + 'px';
        tip.style.top = (e.clientY + 10) + 'px';
      })
      .on('mouseleave', function () { tip.style.display = 'none'; });

    // Right-edge "now" marker
    g.append('line')
      .attr('x1', innerW)
      .attr('x2', innerW)
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', '#22c55e')
      .attr('stroke-width', 1)
      .attr('opacity', 0.5);
  };
})();
