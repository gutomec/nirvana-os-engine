// validator-twin-defaults.test.ts — one capability, one answer, in every language.
//
// `_shared/CONFIGURATION.md` §7 says the JSON Schema, the Zod validator and the
// Pydantic validator mirror each other. For `capability.model_hint` they did
// not: Zod defaulted it to `inherit`, Pydantic to `sonnet`. The same capability,
// with the field absent, resolved to two different models depending on which
// validator read it, and it stayed that way across at least four releases —
// 0.9.0 had the divergence pointing the other way (issue #252).
//
// The published schema is generated from Zod, so those two cannot drift. The
// Python twin is hand-written and nothing compared it to anything, which is the
// gap these cases close.
//
// The second half is about `required`. Zod's `toJSONSchema` defaults to output
// mode, where a field carrying a default is always present in the parsed value
// and therefore mandatory. These schemas validate what an AUTHOR writes, and an
// author writes none of `score_boost`, `model_hint` or `parallel_safe` — the
// validator supplies them. Published in output mode, the schema called three
// optional fields required, so an editor validating a perfectly good capability
// flagged it.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const schema = (name: string) => JSON.parse(read(`skills/_shared/schemas/${name}.schema.json`));
const PY = read("skills/_shared/validators/validators.py");

/** The defaults a Pydantic model class declares, as written in the source.
 *  Handles both shapes the file uses: `field: T = value` and
 *  `field: T = Field(default=value, …)`. */
function pydanticDefaults(className: string): Record<string, string> {
  const start = PY.indexOf(`class ${className}(`);
  expect(start, `class ${className} not found in validators.py`).toBeGreaterThan(-1);
  const rest = PY.slice(start);
  const end = rest.indexOf("\nclass ", 1);
  const body = end === -1 ? rest : rest.slice(0, end);
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{4}([a-z_][a-z0-9_]*)\s*:\s*.+?=\s*(.+?)\s*$/i);
    if (!m) continue;
    const raw = m[2];
    const viaField = raw.match(/^Field\(\s*default\s*=\s*([^,)]+)/);
    const value = (viaField ? viaField[1] : raw).trim();
    if (value === "None" || value.startsWith("Field(") ) continue;   // optional, or no default=
    out[m[1]] = value;
  }
  return out;
}

/** `Model.inherit` → "inherit"; `1.0` → 1; `False` → false. */
function pyLiteral(value: string): unknown {
  const enumMember = value.match(/^[A-Z][A-Za-z0-9_]*\.([a-z_][a-z0-9_]*)$/);
  if (enumMember) return enumMember[1].replace(/_/g, "-");
  if (value === "True") return true;
  if (value === "False") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^['"]|['"]$/g, "");
}

describe("the Python twin agrees with the published schema", () => {
  const capability = schema("capability");
  const pyDefaults = pydanticDefaults("Capability");

  test("model_hint defaults to the same value on both sides", () => {
    // The one that diverged. Named explicitly so the regression is unmissable.
    expect(capability.properties.model_hint.default).toBe("inherit");
    expect(pyLiteral(pyDefaults.model_hint)).toBe("inherit");
  });

  test.each(["score_boost", "model_hint", "parallel_safe"])(
    "%s carries the same default in the schema and in validators.py",
    (field) => {
      const fromSchema = capability.properties[field].default;
      expect(pyDefaults[field], `validators.py declares no default for ${field}`).toBeDefined();
      expect(pyLiteral(pyDefaults[field])).toBe(fromSchema);
    },
  );

  test("every defaulted field in the schema is a field the twin also defaults", () => {
    const defaulted = Object.entries(capability.properties as Record<string, any>)
      .filter(([, v]) => v && typeof v === "object" && "default" in v)
      .map(([k]) => k);
    expect(defaulted.length).toBeGreaterThan(0);
    for (const field of defaulted) {
      expect(pyDefaults[field], `${field} has a default in the schema and none in validators.py`).toBeDefined();
    }
  });
});

describe("a defaulted field is not a required field", () => {
  test.each(["capability", "squad", "workflow"])(
    "%s.schema.json requires nothing it also gives a default",
    (name) => {
      const s = schema(name);
      const required: string[] = s.required ?? [];
      for (const [field, spec] of Object.entries(s.properties as Record<string, any>)) {
        if (spec && typeof spec === "object" && "default" in spec) {
          expect(required, `${name}.${field} is required AND defaulted`).not.toContain(field);
        }
      }
    },
  );

  test("the three fields the output projection used to demand are optional again", () => {
    expect(schema("capability").required).toEqual(["id", "description", "domains", "invoke", "examples"]);
  });

  test("the defaults themselves are still published — only requiredness changed", () => {
    const props = schema("capability").properties;
    expect(props.score_boost.default).toBe(1);
    expect(props.model_hint.default).toBe("inherit");
    expect(props.parallel_safe.default).toBe(false);
  });
});

describe("the documentation lists what the schema accepts", () => {
  test("squads/CONFIGURATION.md gives model_hint the full enum", () => {
    const line = read("skills/squads/CONFIGURATION.md").split("\n").find((l) => l.includes("`model_hint`"))!;
    for (const value of schema("capability").properties.model_hint.enum as string[]) {
      expect(line, `the docs omit '${value}', which the schema accepts`).toContain(value);
    }
  });
});
