/* agent-workspace-renderer.js — PixiJS animated agent workspace.
 *
 * Each agent is a sprite (geometric Tier-1 — colored circle + ring + label).
 * Sprites move between zones based on status:
 *   - Top zone:    "thinking" (running)
 *   - Mid zone:    "tool_in_flight"
 *   - Bottom zone: "completed" / "stale" / "failed"
 * Animations: idle bob, tool pulse ring, status fade, smooth tween between zones.
 *
 * API:
 *   const ws = new window.AgentWorkspace(canvasEl);
 *   ws.syncAgents(agentStates);   // call after every SSE snapshot
 *   ws.destroy();
 *
 * Requires PIXI (loaded via CDN) — degrades gracefully if absent.
 */
(function () {
  if (typeof window === 'undefined') return;

  const COLORS = {
    tool_in_flight: 0xfacc15,
    running: 0x22c55e,
    waiting: 0x3b82f6,
    stale: 0xf59e0b,
    completed: 0x10b981,
    failed: 0xef4444,
    no_match: 0xa3a3a3,
  };

  const HOST_LABELS = {
    'claude-code': 'CC',
    'claude-code-hook': 'CC',
    'gemini-cli': 'GE',
    'gemini-cli-hook': 'GE',
    'codex': 'CX',
    'fs-watch': 'FS',
  };

  function colorFor(status) { return COLORS[status] ?? 0x64748b; }

  // Read a CSS custom property as a 0xRRGGBB int. Returns fallback on failure.
  // Convert any CSS color expression (oklch / rgb / hex / named) to a 0xRRGGBB int
  // by drawing a 1×1 canvas pixel — the most reliable way across browsers since
  // getComputedStyle().color now returns oklch(...) literally in modern Chrome.
  let __pixelProbe;
  function cssVarHex(name, fallback) {
    try {
      const cs = getComputedStyle(document.documentElement);
      const raw = cs.getPropertyValue(name).trim();
      if (!raw) return fallback;
      if (!__pixelProbe) {
        __pixelProbe = document.createElement('canvas');
        __pixelProbe.width = 1; __pixelProbe.height = 1;
      }
      const ctx = __pixelProbe.getContext('2d', { willReadFrequently: true });
      // Clear any prior fill (transparent default), then paint with the resolved color.
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000000';
      ctx.fillStyle = raw;            // browser parses oklch/rgb/hex into a usable color
      // If the parser rejected raw, fillStyle stays '#000000' — fall back instead.
      if (ctx.fillStyle === '#000000' && !/^\s*(black|#000|#000000|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/.test(raw)) {
        return fallback;
      }
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (a === 0) return fallback;
      return ((r << 16) | (g << 8) | b) >>> 0;
    } catch { return fallback; }
  }

  function zoneY(status, height) {
    if (status === 'running' || status === 'waiting') return height * 0.25;
    if (status === 'tool_in_flight') return height * 0.55;
    return height * 0.82; // completed / stale / failed
  }

  // Simple deterministic-ish horizontal placement so sprites don't overlap.
  // Wraps to multiple rows when count exceeds what fits at min spacing.
  function zoneX(idx, count, width) {
    const margin = 80;
    const usable = width - margin * 2;
    if (count <= 1) return width / 2;
    const minSpacing = 120;
    const perRow = Math.max(2, Math.floor(usable / minSpacing) + 1);
    const colIdx = idx % perRow;
    const colsInThisRow = Math.min(perRow, count - Math.floor(idx / perRow) * perRow);
    if (colsInThisRow <= 1) return width / 2;
    const step = usable / (colsInThisRow - 1);
    return margin + colIdx * step;
  }
  function zoneRow(idx, count, perRow) {
    return Math.floor(idx / perRow);
  }

  class AgentWorkspace {
    constructor(canvasEl) {
      this.canvas = canvasEl;
      this.sprites = new Map();   // trace_id → sprite container
      this.targets = new Map();   // trace_id → {x, y}
      this.alive = true;

      if (!window.PIXI) {
        console.warn('[agent-workspace] PixiJS not loaded — workspace disabled');
        this.app = null;
        return;
      }

      this.app = new window.PIXI.Application();
      const w = canvasEl.clientWidth || 800;
      const h = canvasEl.clientHeight || 500;
      // PIXI v8 init is async; wrap in promise
      this._ready = this.app.init({
        canvas: canvasEl,
        width: w,
        height: h,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      }).then(() => {
        this._drawZones();
        this.app.ticker.add(this._tick.bind(this));
        // resize on container size changes
        this._ro = new ResizeObserver(() => this._handleResize());
        this._ro.observe(canvasEl);
      }).catch(err => {
        console.warn('[agent-workspace] PIXI init failed', err);
        this.app = null;
      });
    }

    _handleResize() {
      if (!this.app) return;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.app.renderer.resize(w, h);
      this._drawZones();
      // recompute targets for current sprites
      this._reflow();
    }

    _refreshThemeColors() {
      // Resolve current theme's --fg / --fg-muted / surface into ints.
      this._themeLabel = cssVarHex('--fg', 0xe2e8f0);
      this._themeLabelMuted = cssVarHex('--fg-muted', 0x94a3b8);
      // Halo is the inverse of the label so the text stays legible on either
      // light or dark canvases. We compute it from luminance of the label.
      const lab = this._themeLabel;
      const r = (lab >> 16) & 0xff, g = (lab >> 8) & 0xff, b = lab & 0xff;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      this._themeLabelHalo = lum > 128 ? 0x000000 : 0xffffff;
    }

    _drawZones() {
      if (!this.app) return;
      if (this._zoneLayer) this.app.stage.removeChild(this._zoneLayer);
      this._refreshThemeColors();
      const layer = new window.PIXI.Container();
      const w = this.app.renderer.width;
      const h = this.app.renderer.height;

      const labels = [
        { text: 'thinking', y: h * 0.10, color: 0x22c55e },
        { text: 'tool in flight', y: h * 0.42, color: 0xfacc15 },
        { text: 'completed / stale', y: h * 0.70, color: 0x10b981 },
      ];
      for (const z of labels) {
        const line = new window.PIXI.Graphics();
        line.moveTo(40, z.y).lineTo(w - 40, z.y);
        line.stroke({ color: z.color, alpha: 0.32, width: 1 });
        layer.addChild(line);
        const txt = new window.PIXI.Text({
          text: z.text,
          style: { fill: z.color, fontSize: 11, fontFamily: 'Inter, system-ui', fontWeight: '600' },
        });
        txt.alpha = 0.85;
        txt.x = 48;
        txt.y = z.y - 16;
        layer.addChild(txt);
      }
      this._zoneLayer = layer;
      this.app.stage.addChild(layer);
    }

    _createSprite(state) {
      const c = new window.PIXI.Container();
      c.eventMode = 'static';
      c.cursor = 'pointer';
      c.__data = state;

      // outer pulse ring (only visible on tool_in_flight)
      const ring = new window.PIXI.Graphics();
      ring.circle(0, 0, 22);
      ring.stroke({ color: colorFor(state.status), alpha: 0.6, width: 2 });
      ring.alpha = 0;
      c.addChild(ring);

      // body
      const body = new window.PIXI.Graphics();
      body.circle(0, 0, 14);
      body.fill({ color: colorFor(state.status), alpha: 0.85 });
      body.stroke({ color: 0xffffff, alpha: 0.25, width: 1 });
      c.addChild(body);

      // host badge
      const badge = new window.PIXI.Text({
        text: HOST_LABELS[state.host] || '··',
        style: { fill: 0xffffff, fontSize: 9, fontFamily: 'JetBrains Mono, monospace', fontWeight: '700' },
      });
      badge.anchor.set(0.5, 0.5);
      c.addChild(badge);

      // label — uses theme-aware fg color, with halo stroke so it stays legible
      // over either the dark canvas or the lighter zone bands.
      const labelText = state.label || '';
      const truncated = labelText.length > 28 ? labelText.slice(0, 26) + '…' : labelText;
      const label = new window.PIXI.Text({
        text: truncated,
        style: {
          fill: this._themeLabel ?? 0xe2e8f0,
          fontSize: 11,
          fontFamily: 'Inter, system-ui',
          fontWeight: '600',
          stroke: { color: this._themeLabelHalo ?? 0x000000, width: 3, alpha: 0.55 },
          align: 'center',
        },
      });
      label.anchor.set(0.5, 0);
      label.y = 22;
      c.addChild(label);

      c.__ring = ring;
      c.__body = body;
      c.__badge = badge;
      c.__label = label;
      c.__bobPhase = Math.random() * Math.PI * 2;

      // tooltip on hover
      c.on('pointerover', () => { c.scale.set(1.1); });
      c.on('pointerout', () => { c.scale.set(1); });

      return c;
    }

    _updateSpriteVisuals(c, state) {
      const color = colorFor(state.status);
      c.__body.clear();
      c.__body.circle(0, 0, 14);
      c.__body.fill({ color, alpha: state.status === 'completed' ? 0.55 : 0.85 });
      c.__body.stroke({ color: 0xffffff, alpha: 0.25, width: 1 });

      c.__ring.clear();
      c.__ring.circle(0, 0, 22);
      c.__ring.stroke({ color, alpha: 0.6, width: 2 });

      c.__data = state;
      c.__label.text = state.label || '';
      c.__label.style.fill = this._themeLabel ?? 0xe2e8f0;
      c.__badge.text = HOST_LABELS[state.host] || '··';
    }

    _tick(ticker) {
      if (!this.app) return;
      const dt = ticker.deltaTime || 1;
      const time = performance.now() / 1000;

      for (const [, c] of this.sprites) {
        const target = this.targets.get(c.__data.trace_id);
        if (target) {
          // ease toward target
          c.x += (target.x - c.x) * 0.12 * dt;
          c.y += (target.y - c.y) * 0.12 * dt;
        }

        // idle bob
        const status = c.__data.status;
        if (status === 'running' || status === 'tool_in_flight') {
          c.y += Math.sin(time * 2 + c.__bobPhase) * 0.3;
        }

        // tool pulse ring
        if (status === 'tool_in_flight') {
          c.__ring.alpha = 0.4 + 0.4 * Math.sin(time * 3.5 + c.__bobPhase);
          c.__ring.scale.set(1 + 0.08 * Math.sin(time * 3.5 + c.__bobPhase));
        } else {
          c.__ring.alpha *= 0.92; // fade out
        }

        // completed fade
        if (status === 'completed') {
          c.alpha = Math.max(0.55, c.alpha * 0.998);
        } else if (status === 'failed') {
          c.alpha = 0.7 + 0.3 * Math.sin(time * 6); // rapid blink
        } else {
          c.alpha = Math.min(1, c.alpha + 0.05 * dt);
        }
      }
    }

    _reflow() {
      if (!this.app) return;
      const w = this.app.renderer.width;
      const h = this.app.renderer.height;
      const states = Array.from(this.sprites.values()).map(c => c.__data);

      // Group by zone; place evenly within each zone.
      const groups = { top: [], mid: [], bottom: [] };
      for (const s of states) {
        if (s.status === 'tool_in_flight') groups.mid.push(s);
        else if (s.status === 'completed' || s.status === 'stale' || s.status === 'failed') groups.bottom.push(s);
        else groups.top.push(s);
      }
      const place = (group) => {
        const margin = 80;
        const minSpacing = 120;
        const perRow = Math.max(2, Math.floor((w - margin * 2) / minSpacing) + 1);
        group.forEach((s, i) => {
          const row = Math.floor(i / perRow);
          const baseY = zoneY(s.status, h);
          this.targets.set(s.trace_id, {
            x: zoneX(i, group.length, w),
            y: baseY + row * 56,
          });
        });
      };
      place(groups.top); place(groups.mid); place(groups.bottom);
    }

    syncAgents(states) {
      if (!this.app) return;
      // Wait for init if it's still pending.
      if (this._ready && !this._initDone) {
        this._ready.then(() => { this._initDone = true; this.syncAgents(states); });
        return;
      }
      // Refresh theme colors every sync so a mid-session theme switch
      // immediately repaints the labels and zone bands.
      this._refreshThemeColors();
      // Recolor existing sprite labels (fill + halo stroke)
      for (const c of this.sprites.values()) {
        if (c.__label) {
          c.__label.style.fill = this._themeLabel ?? 0xe2e8f0;
          c.__label.style.stroke = { color: this._themeLabelHalo ?? 0x000000, width: 3, alpha: 0.55 };
        }
      }
      // Redraw zone labels with the new colors too
      this._drawZones();
      const seen = new Set();
      for (const s of states) {
        seen.add(s.trace_id);
        let c = this.sprites.get(s.trace_id);
        if (!c) {
          c = this._createSprite(s);
          // spawn off-screen-bottom for entrance animation
          c.x = this.app.renderer.width / 2;
          c.y = this.app.renderer.height + 30;
          c.alpha = 0;
          this.app.stage.addChild(c);
          this.sprites.set(s.trace_id, c);
        } else {
          this._updateSpriteVisuals(c, s);
        }
      }
      // remove sprites for vanished traces
      for (const [tid, c] of this.sprites) {
        if (!seen.has(tid)) {
          this.app.stage.removeChild(c);
          c.destroy({ children: true });
          this.sprites.delete(tid);
          this.targets.delete(tid);
        }
      }
      this._reflow();
    }

    destroy() {
      this.alive = false;
      if (this._ro) try { this._ro.disconnect(); } catch {}
      if (this.app) {
        try { this.app.destroy(true, { children: true }); } catch {}
      }
    }
  }

  window.AgentWorkspace = AgentWorkspace;
})();
