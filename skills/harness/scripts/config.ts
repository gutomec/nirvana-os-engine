#!/usr/bin/env bun
// config.ts — `nrv config list|get|set|unset|explain`: the operational
// settings of the engine (_shared/lib/settings-schema.ts), resolved by
// _shared/lib/settings.ts with one precedence: environment variable >
// <project>/.nirvana/config.yaml > ~/.nirvana/config.yaml > the engine's
// skills/harness/config.yaml > the schema default.
//
//   nrv config list [--json]                          every key: effective value, origin, default
//   nrv config get <key> [--json]                     the effective value (the whole resolution with --json)
//   nrv config set <key> <value> [--global|--project]
//   nrv config unset <key> [--global|--project]
//   nrv config explain <key> [--json]                 description, default, scopes, variable, effective value
//
// `set` and `unset` default to --project inside a Nirvana project (a `.nirvana/`
// directory in the cwd or an ancestor, or NIRVANA_PROJECT_ROOT), else --global.
// A value the schema refuses, a scope the key does not accept, and a key pinned
// by a variable in this shell are refusals with the reason. Every write audits
// `x_settings_changed { key, scope, path, from, to }`.
//
// Exit: 0 ok · 1 a config file could not be read · 4 invalid arguments, key,
// value or scope, or the key is pinned by the environment.
//
// i18n-user-facing: file — what the user reads is PT-BR by contract; code,
// identifiers and comments stay English.

import { createRequire } from "node:module";
import * as os from "node:os";
import {
  defaultWriteScope, requireSpec, resolveAllSettings, resolveSetting, setSetting, settingInfo, SettingsError, unsetSetting,
  type ResolvedSetting, type SettingScope, type SettingValue,
} from "../../_shared/lib/settings.ts";

const EXIT = { ok: 0, failure: 1, invalid: 4 } as const;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
const positional = argv.filter((argument) => !argument.startsWith("--"));
const command = positional[0] ?? "list";
const json = flags.has("--json");

function usage(code: number): never {
  console.error([
    "uso:",
    "  nrv config list [--json]                          toda chave: valor efetivo, origem, padrão",
    "  nrv config get <chave> [--json]                   o valor efetivo",
    "  nrv config set <chave> <valor> [--global|--project]",
    "  nrv config unset <chave> [--global|--project]",
    "  nrv config explain <chave> [--json]               descrição, padrão, escopos, variável, valor efetivo",
    "",
    "  precedência: variável de ambiente > <projeto>/.nirvana/config.yaml > ~/.nirvana/config.yaml > engine > padrão",
    "  set/unset gravam no projeto quando rodam dentro de um (diretório .nirvana/), senão no global.",
    "  exit: 0 ok · 1 arquivo de config ilegível · 4 argumento, chave, valor ou escopo inválido, ou chave fixada por variável",
  ].join("\n"));
  process.exit(code);
}

function tilde(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function sourceLabel(resolved: ResolvedSetting): string {
  switch (resolved.source) {
    case "env": return `env ${resolved.variable}=${resolved.raw}`;
    case "project": return `projeto ${tilde(resolved.path!)}`;
    case "global": return `global ${tilde(resolved.path!)}`;
    case "engine-default": return `engine ${tilde(resolved.path!)}`;
    default: return "padrão";
  }
}

const scopeWord = (scope: SettingScope): string => (scope === "project" ? "projeto" : "global");

function show(value: SettingValue | null): string {
  if (value === null) return "(ausente)";
  return typeof value === "string" ? (value === "" ? '""' : value) : String(value);
}

/** The resolution plus the schema, for --json consumers (the Glance panel reads the same shape). */
function report(resolved: ResolvedSetting): Record<string, unknown> {
  return { ...settingInfo(requireSpec(resolved.key)), ...resolved };
}

function scopeFlag(): SettingScope | null {
  const global = flags.has("--global");
  const project = flags.has("--project");
  if (global && project) usage(EXIT.invalid);
  return global ? "global" : project ? "project" : null;
}

const audit = (event: string, payload: Record<string, unknown>): void => {
  try { createRequire(import.meta.url)("../lib/audit.js").emit(event, payload); }
  catch (error) { console.error(`aviso: o audit não foi gravado (${(error as Error).message})`); }
};

function list(): number {
  const all = resolveAllSettings();
  if (json) { console.log(JSON.stringify(all.map(report), null, 2)); return EXIT.ok; }
  const rows = all.map((resolved) => [resolved.key, show(resolved.value), sourceLabel(resolved), show(requireSpec(resolved.key).default)]);
  const header = ["chave", "valor", "origem", "padrão"];
  const widths = header.slice(0, 3).map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
  const line = (row: string[]) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3]}`;
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  return EXIT.ok;
}

function get(key: string): number {
  const resolved = resolveSetting(key);
  if (json) console.log(JSON.stringify(report(resolved), null, 2));
  else console.log(String(resolved.value));
  return EXIT.ok;
}

function explain(key: string): number {
  const spec = requireSpec(key);
  const resolved = resolveSetting(key);
  if (json) { console.log(JSON.stringify(report(resolved), null, 2)); return EXIT.ok; }
  const info = settingInfo(spec);
  const variable = info.env ? `${info.env}${info.envAliases.length ? ` (também ${info.envAliases.join(", ")})` : ""}` : "(nenhuma)";
  console.log([
    `${key} — ${info.description}`,
    `  tipo:     ${info.expects}`,
    `  padrão:   ${show(info.default)}`,
    `  escopos:  ${info.scopes.map(scopeWord).join(", ")}`,
    `  variável: ${variable}`,
    `  efetivo:  ${show(resolved.value)} (${sourceLabel(resolved)})`,
  ].join("\n"));
  return EXIT.ok;
}

/** After a write, the value in force may still come from a higher layer; say so. */
function reportEffective(key: string, scope: SettingScope): void {
  const effective = resolveSetting(key);
  if (effective.source !== scope) console.log(`valor efetivo agora: ${show(effective.value)} (${sourceLabel(effective)})`);
}

function set(key: string, value: string): number {
  const scope = scopeFlag() ?? defaultWriteScope().scope;
  const change = setSetting(key, value, { scope, audit });
  if (change.changed) {
    const was = change.from === null ? "" : ` (era ${show(change.from)})`;
    console.log(`${key} = ${show(change.to)} gravado em ${tilde(change.path)} (${scopeWord(scope)})${was}`);
  } else {
    console.log(`${key} já era ${show(change.to)} em ${tilde(change.path)} (${scopeWord(scope)}); nada mudou`);
  }
  reportEffective(key, scope);
  return EXIT.ok;
}

function unset(key: string): number {
  const scope = scopeFlag() ?? defaultWriteScope().scope;
  const change = unsetSetting(key, { scope, audit });
  if (change.changed) console.log(`${key} removido de ${tilde(change.path)} (${scopeWord(scope)}); era ${show(change.from)}`);
  else console.log(`${key} não estava definido em ${tilde(change.path)} (${scopeWord(scope)}); nada mudou`);
  reportEffective(key, scope);
  return EXIT.ok;
}

function main(): number {
  const key = positional[1];
  switch (command) {
    case "list": return list();
    case "get": if (!key) usage(EXIT.invalid); return get(key);
    case "explain": if (!key) usage(EXIT.invalid); return explain(key);
    case "set": if (!key || positional.length < 3) usage(EXIT.invalid); return set(key, positional[2]);
    case "unset": if (!key) usage(EXIT.invalid); return unset(key);
    case "help": case "-h": usage(EXIT.ok);
    default: usage(EXIT.invalid);
  }
}

try {
  process.exit(main());
} catch (error) {
  if (error instanceof SettingsError) {
    console.error(`nrv config: ${error.message}`);
    process.exit(error.code === "invalid_file" ? EXIT.failure : EXIT.invalid);
  }
  throw error;
}
