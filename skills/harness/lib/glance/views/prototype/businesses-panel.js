// businesses-panel.js — real data from the REAL running Glance API
// (GET /api/businesses, the same route the shipped Businesses tab calls).
// Demonstrates: a signal holding server data, a derived filter with no
// manual re-render wiring, and a real fetch-timing measurement (not a
// marketing claim — an actual number read off this machine's own registry).
import { html } from "htm/preact";
import { useSignal, useSignalEffect } from "@preact/signals";
import { Panel } from "./panel.js";

let renderCount = 0;

export function BusinessesPanel() {
  renderCount++;
  const businesses = useSignal([]);
  const filter = useSignal("");
  const loading = useSignal(true);
  const error = useSignal(null);
  const fetchMs = useSignal(0);

  useSignalEffect(() => {
    const t0 = performance.now();
    fetch("/api/businesses")
      .then(r => r.json())
      .then(data => {
        businesses.value = data.businesses || [];
        fetchMs.value = Math.round(performance.now() - t0);
        loading.value = false;
      })
      .catch(e => { error.value = String(e); loading.value = false; });
  });

  const q = filter.value.trim().toLowerCase();
  const filtered = q ? businesses.value.filter(b => b.slug.toLowerCase().includes(q)) : businesses.value;

  return html`
    <${Panel} title="Businesses" hint="dado real de GET /api/businesses">
      <input
        class="w-full mb-3 px-2 py-1.5 text-sm bg-[var(--surface-2)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        placeholder="filtrar por slug..."
        value=${filter.value}
        onInput=${e => { filter.value = e.target.value; }}
      />
      ${loading.value && html`<p class="text-sm text-[var(--text-tertiary)]">carregando...</p>`}
      ${error.value && html`<p class="text-sm text-[var(--status-danger-fg)]">${error.value}</p>`}
      <ul class="flex flex-col gap-1 max-h-64 overflow-auto">
        ${filtered.map(b => html`
          <li key=${b.slug} class="text-sm px-2 py-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)]">
            <b>${b.slug}</b>
            <span class="text-[var(--text-tertiary)]"> · ${(b.domains || []).slice(0, 3).join(", ")}</span>
          </li>
        `)}
      </ul>
      <p class="text-[10px] text-[var(--text-tertiary)] mt-2">
        ${filtered.length} de ${businesses.value.length} · fetch em ${fetchMs.value}ms · este componente renderizou ${renderCount}x
      </p>
    </${Panel}>
  `;
}
