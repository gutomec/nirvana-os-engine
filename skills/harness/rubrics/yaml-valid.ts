// yaml-valid.ts — validates that the YAML is parseable and has structured content.
// Uses the `yaml` lib (v2) already present in the engine (cf. lib/budget.js).
import { parse } from "yaml";

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  if (!content || !content.trim()) {
    return { name: "yaml-valid", passed: false, score: 0, reasoning: "Empty YAML.", fix_list: ["Write YAML content."] };
  }
  try {
    const parsed = parse(content);
    const isStruct = parsed !== null && typeof parsed === "object";
    const count = Array.isArray(parsed) ? parsed.length : (isStruct ? Object.keys(parsed).length : 0);
    const passed = isStruct && count > 0;
    return {
      name: "yaml-valid",
      passed,
      score: passed ? 1.0 : 0.5,
      reasoning: passed
        ? `Valid YAML with ${count} top-level ${Array.isArray(parsed) ? "items" : "keys"}.`
        : "YAML parses but the root is a scalar or empty.",
      fix_list: passed ? [] : ["The root should be a map or a list with content."],
    };
  } catch (e: any) {
    return {
      name: "yaml-valid",
      passed: false,
      score: 0,
      reasoning: `YAML parse error: ${e.message}`,
      fix_list: [`Fix the YAML syntax: ${String(e.message).slice(0, 100)}`],
    };
  }
}
