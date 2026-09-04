// panel.js — the ONE reusable floating-panel component this whole prototype
// leans on. In the real Glance today the same visual pattern (header +
// scrollable body + footer with Salvar/Cancelar) is hand-duplicated three
// times with near-identical markup and CSS: .memory-add-modal, .graph-settings
// and .org-edit-panel (index.html/glance.css). Here it is written once.
import { html } from "htm/preact";

export function Panel({ title, hint, children, footer }) {
  return html`
    <section class="bg-[var(--surface-1)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-2)] overflow-hidden flex flex-col">
      <header class="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border-default)] bg-[var(--surface-0)]">
        <span class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">${title}</span>
        ${hint && html`<span class="text-[10px] text-[var(--text-tertiary)]">${hint}</span>`}
      </header>
      <div class="p-4 flex-1 overflow-auto">${children}</div>
      ${footer && html`<footer class="flex gap-2 px-4 py-3 border-t border-[var(--border-default)]">${footer}</footer>`}
    </section>
  `;
}
