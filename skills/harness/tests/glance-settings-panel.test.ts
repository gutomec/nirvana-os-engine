// glance-settings-panel.test.ts — the pure module behind the Glance
// "Configuração" panel: groups and fields rendered from the API payload (the
// real schema, through settingInfo), the locked state of a key pinned by a
// variable, the control per kind, the mapping from a control's input to the
// value the API receives, the requests and the notices the panel shows.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import { SETTINGS_SCHEMA, settingInfo } from "../../_shared/lib/settings.ts";
import {
  GROUP_LABELS, buildSettingsPanel, changeNotice, controlFor, controlState, defaultScope, displayValue, groupLabel,
  inputValue, lockReason, problemMessage, sourceLabel, unsetRequest, writeRequest,
} from "../lib/glance/views/settings-panel.js";

const schema = SETTINGS_SCHEMA.map(settingInfo);
const entry = (value: unknown, source = "default", extra: Record<string, unknown> = {}) =>
  ({ value, source, path: null, variable: null, raw: null, locked: source === "env", ...extra });
const values: Record<string, unknown> = Object.fromEntries(schema.map((spec) => [spec.key, entry(spec.default)]));
values["routing.mode"] = entry("fast", "project", { path: "/prj/.nirvana/config.yaml" });
values["gauntlet.evaluator"] = entry("judge-x", "global", { path: "/home/.nirvana/config.yaml" });
values["multi_target.enabled"] = entry(false, "env", { variable: "NIRVANA_MULTI_TARGET_KILL_SWITCH", raw: "1" });
values["budget.default_max_cost_usd"] = entry(0, "engine-default", { path: "/engine/skills/harness/config.yaml" });
const payload = { schema, values, files: { project: { path: "/prj/.nirvana/config.yaml", exists: true } }, allow_actions: true };

describe("Glance settings panel module", () => {
  test("groups every schema key by section, in schema order, with PT-BR labels and the seven groups the panel names", () => {
    const panel = buildSettingsPanel(payload);
    expect(panel.groups.map((group: any) => group.id)).toEqual([...new Set(SETTINGS_SCHEMA.map((spec) => spec.key.split(".")[0]))]);
    expect(panel.groups.flatMap((group: any) => group.fields.map((field: any) => field.key))).toEqual(SETTINGS_SCHEMA.map((spec) => spec.key));
    const labels = Object.fromEntries(panel.groups.map((group: any) => [group.id, group.label]));
    expect(labels).toMatchObject({ gauntlet: "Gauntlet", multi_target: "Multi-target", execution: "Execução", runtime: "Runtime", routing: "Roteamento", supervisor: "Supervisor", updates: "Atualizações" });
    expect(Object.keys(GROUP_LABELS)).toEqual(expect.arrayContaining(Object.keys(labels)));
    expect(groupLabel("future_section")).toBe("future section");
    expect(panel.allowActions).toBe(true);
    expect(panel.files.project.path).toBe("/prj/.nirvana/config.yaml");
  });

  test("a field carries the schema, the effective value, its origin in words and the control for its kind", () => {
    const fields = Object.fromEntries(buildSettingsPanel(payload).groups.flatMap((group: any) => group.fields).map((field: any) => [field.key, field]));
    expect(fields["routing.mode"]).toMatchObject({
      section: "routing", name: "mode", kind: "enum", control: "select", options: ["agentic", "fast"], default: "agentic",
      value: "fast", source: "project", sourceLabel: "projeto", origin: "/prj/.nirvana/config.yaml", locked: false, writable: true, env: "NIRVANA_ROUTING_MODE",
    });
    expect(typeof fields["routing.mode"].description).toBe("string");
    expect(fields["gauntlet.evaluator"]).toMatchObject({ kind: "string", control: "text", value: "judge-x", sourceLabel: "global", origin: "/home/.nirvana/config.yaml" });
    expect(fields["supervisor.progress_ping_sec"]).toMatchObject({ kind: "number", control: "number", value: 1800, source: "default", sourceLabel: "padrão", origin: "" });
    expect(fields["budget.default_max_cost_usd"]).toMatchObject({ source: "engine-default", sourceLabel: "engine", origin: "/engine/skills/harness/config.yaml" });
    expect(fields["updates.check"]).toMatchObject({ kind: "boolean", control: "toggle", scopes: ["global"] });
    expect(controlFor("boolean")).toBe("toggle");
    expect(controlFor("enum")).toBe("select");
    expect(controlFor("number")).toBe("number");
    expect(controlFor("string")).toBe("text");
    expect(controlFor("unknown")).toBe("text");
  });

  test("a key pinned by a variable is locked and read-only, with the variable in the reason; read-only mode locks everything", () => {
    const fields = Object.fromEntries(buildSettingsPanel(payload).groups.flatMap((group: any) => group.fields).map((field: any) => [field.key, field]));
    const pinned = fields["multi_target.enabled"];
    expect(pinned).toMatchObject({ locked: true, writable: false, value: false, source: "env", variable: "NIRVANA_MULTI_TARGET_KILL_SWITCH", raw: "1", sourceLabel: "variável NIRVANA_MULTI_TARGET_KILL_SWITCH=1", origin: "" });
    expect(pinned.lockReason).toContain("NIRVANA_MULTI_TARGET_KILL_SWITCH=1");
    expect(lockReason({ source: "project" })).toBe("");
    expect(sourceLabel({ source: "env" })).toBe("variável de ambiente");
    const readOnly = buildSettingsPanel({ ...payload, allow_actions: false });
    expect(readOnly.allowActions).toBe(false);
    expect(readOnly.groups.every((group: any) => group.fields.every((field: any) => field.writable === false))).toBe(true);
    expect(readOnly.groups.flatMap((group: any) => group.fields).filter((field: any) => field.locked).map((field: any) => field.key)).toEqual(["multi_target.enabled"]);
  });

  test("a key missing from values falls back to its default; a malformed payload renders nothing", () => {
    const partial = buildSettingsPanel({ schema: schema.slice(0, 2), values: {}, allow_actions: true });
    expect(partial.groups.flatMap((group: any) => group.fields).map((field: any) => [field.key, field.value, field.source])).toEqual([
      ["multi_target.enabled", true, "default"], ["gauntlet.default_mode", "standard", "default"],
    ]);
    expect(buildSettingsPanel(null)).toEqual({ groups: [], files: null, allowActions: false });
    expect(buildSettingsPanel({ schema: [{ key: "nodot" }, null] }).groups).toEqual([]);
  });

  test("controls map their input to the value the API receives and show values as words", () => {
    const toggle = { key: "multi_target.enabled", kind: "boolean", control: "toggle", value: true, scopes: ["global", "project"] };
    const number = { key: "supervisor.progress_ping_sec", kind: "number", control: "number", value: 1800, scopes: ["global", "project"] };
    const text = { key: "gauntlet.evaluator", kind: "string", control: "text", value: "", scopes: ["global", "project"] };
    expect(controlState(toggle)).toBe(true);
    expect(controlState(number)).toBe("1800");
    expect(controlState(text)).toBe("");
    expect(inputValue(toggle, false)).toBe(false);
    expect(inputValue(toggle, "true")).toBe(true);
    expect(inputValue(number, " 7 ")).toBe(" 7 ");
    expect(inputValue(text, null)).toBe("");
    expect(displayValue(toggle)).toBe("ligado");
    expect(displayValue(toggle, false)).toBe("desligado");
    expect(displayValue(text)).toBe("(vazio)");
    expect(displayValue(number)).toBe("1800");
    expect(displayValue(null, null)).toBe("(ausente)");
    expect(defaultScope(toggle)).toBe("project");
    expect(defaultScope(toggle, false)).toBe("global");
    expect(defaultScope({ scopes: ["global"] })).toBe("global");
  });

  test("requests target /api/v1/settings/<key> with the scope, and notices read the API's answer", () => {
    const field = { key: "routing.mode", kind: "enum", control: "select", value: "agentic", scopes: ["global", "project"] };
    expect(writeRequest(field, "project", "fast")).toEqual({ method: "PUT", path: "/api/v1/settings/routing.mode", body: { value: "fast", scope: "project" } });
    expect(unsetRequest(field, "global")).toEqual({ method: "DELETE", path: "/api/v1/settings/routing.mode?scope=global", body: null });
    expect(changeNotice({ key: "routing.mode", scope: "project", path: "/p/config.yaml", from: null, to: "fast", changed: true, effective: { value: "fast", source: "project" } }))
      .toBe("routing.mode = fast gravado em projeto (/p/config.yaml)");
    expect(changeNotice({ key: "routing.mode", scope: "global", path: "/g/config.yaml", from: "fast", to: "agentic", changed: true, effective: { value: "fast", source: "project" } }))
      .toBe("routing.mode = agentic gravado em global (/g/config.yaml) (era fast) · valor efetivo agora: fast (projeto)");
    expect(changeNotice({ key: "routing.mode", scope: "project", path: "/p/config.yaml", from: "fast", to: "fast", changed: false, effective: { value: "fast", source: "project" } }))
      .toBe("routing.mode já era fast em projeto (/p/config.yaml); nada mudou");
    expect(changeNotice({ key: "routing.mode", scope: "project", path: "/p/config.yaml", from: "fast", to: null, changed: true, effective: { value: "agentic", source: "default" } }))
      .toBe("routing.mode removido de projeto (/p/config.yaml); era fast · valor efetivo agora: agentic (padrão)");
    expect(changeNotice({ key: "routing.mode", scope: "project", path: "/p/config.yaml", from: null, to: null, changed: false, effective: { value: "agentic", source: "project" } }))
      .toBe("routing.mode não estava definido em projeto (/p/config.yaml); nada mudou");
    expect(changeNotice(null)).toBe("");
    expect(problemMessage({ type: "about:blank", title: "Invalid value", detail: 'routing.mode: valor inválido "turbo"' }, 400)).toBe('routing.mode: valor inválido "turbo"');
    expect(problemMessage({ title: "Forbidden" }, 403)).toBe("Forbidden");
    expect(problemMessage({ error: "actions disabled" }, 403)).toBe("actions disabled");
    expect(problemMessage(null, 500)).toBe("HTTP 500");
  });
});
