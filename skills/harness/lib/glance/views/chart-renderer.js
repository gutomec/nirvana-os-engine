/* chart-renderer.js — minimal canvas-based bar/line charts for Glance.
 *
 * Pure canvas2d, no dep. Draws stacked-bar daily token usage and a USD line.
 * Theme-aware via CSS computed styles.
 *
 * Public:
 *   window.renderCostCharts(cost) — populates #cost-tokens-chart and #cost-usd-chart
 */

(function () {
  function isDark() {
    const t = document.documentElement.dataset.theme || "";
    return t === "apple-dark" || t === "awwwards";
  }

  function clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }

  function drawAxes(ctx, w, h, padding) {
    ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, h - padding.bottom);
    ctx.lineTo(w - padding.right, h - padding.bottom);
    ctx.stroke();
  }

  function drawStackedTokenBars(canvas, daily) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    clear(ctx, w, h);
    const padding = { top: 24, right: 24, bottom: 36, left: 64 };
    drawAxes(ctx, w, h, padding);
    if (!daily || daily.length === 0) {
      ctx.fillStyle = isDark() ? "#666" : "#999";
      ctx.font = "12px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText("no cost_emission events", w / 2, h / 2);
      return;
    }
    const maxTotal = Math.max(...daily.map(d => d.total)) || 1;
    const innerW = w - padding.left - padding.right;
    const innerH = h - padding.top - padding.bottom;
    const barW = Math.max(4, Math.floor(innerW / daily.length) - 4);

    const colors = {
      input: "#3b82f6",
      cache_creation: "#a855f7",
      cache_read: "#10b981",
      output: "#f59e0b",
    };
    const order = ["input", "cache_creation", "cache_read", "output"];

    daily.forEach((d, i) => {
      const x = padding.left + i * (barW + 4);
      let y = h - padding.bottom;
      for (const k of order) {
        const v = d[k] || 0;
        if (v === 0) continue;
        const segH = (v / maxTotal) * innerH;
        ctx.fillStyle = colors[k];
        ctx.fillRect(x, y - segH, barW, segH);
        y -= segH;
      }
      // x-label (every 2nd bar)
      if (i % Math.max(1, Math.floor(daily.length / 8)) === 0) {
        ctx.fillStyle = isDark() ? "#888" : "#666";
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(d.day.slice(5), x + barW / 2, h - padding.bottom + 14);
      }
    });

    // Legend
    let lx = padding.left;
    ctx.font = "10px ui-sans-serif, system-ui";
    for (const k of order) {
      ctx.fillStyle = colors[k];
      ctx.fillRect(lx, padding.top - 16, 8, 8);
      ctx.fillStyle = isDark() ? "#ccc" : "#333";
      ctx.textAlign = "left";
      ctx.fillText(k, lx + 12, padding.top - 9);
      lx += ctx.measureText(k).width + 28;
    }
    // Y max
    ctx.fillStyle = isDark() ? "#888" : "#666";
    ctx.textAlign = "right";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(maxTotal.toLocaleString(), padding.left - 6, padding.top + 8);
  }

  function drawUsdLine(canvas, daily) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    clear(ctx, w, h);
    const padding = { top: 24, right: 24, bottom: 36, left: 64 };
    drawAxes(ctx, w, h, padding);
    if (!daily || daily.length === 0) return;
    const maxUsd = Math.max(...daily.map(d => d.usd)) || 1;
    const innerW = w - padding.left - padding.right;
    const innerH = h - padding.top - padding.bottom;
    const stepX = daily.length > 1 ? innerW / (daily.length - 1) : 0;

    ctx.strokeStyle = "#10b981";
    ctx.fillStyle = "rgba(16,185,129,0.15)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    daily.forEach((d, i) => {
      const x = padding.left + i * stepX;
      const y = h - padding.bottom - (d.usd / maxUsd) * innerH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill area under line
    ctx.lineTo(padding.left + (daily.length - 1) * stepX, h - padding.bottom);
    ctx.lineTo(padding.left, h - padding.bottom);
    ctx.closePath();
    ctx.fill();

    // Y max
    ctx.fillStyle = isDark() ? "#888" : "#666";
    ctx.textAlign = "right";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("$" + maxUsd.toFixed(2), padding.left - 6, padding.top + 8);

    // Title
    ctx.fillStyle = isDark() ? "#ccc" : "#333";
    ctx.textAlign = "left";
    ctx.font = "11px ui-sans-serif, system-ui";
    ctx.fillText("daily USD", padding.left, padding.top - 6);
  }

  window.renderCostCharts = function (cost) {
    if (!cost) return;
    const tokensEl = document.querySelector("#cost-tokens-chart");
    const usdEl = document.querySelector("#cost-usd-chart");
    if (tokensEl) drawStackedTokenBars(tokensEl, cost.daily || []);
    if (usdEl) drawUsdLine(usdEl, cost.daily || []);
  };
})();
