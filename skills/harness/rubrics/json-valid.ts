// json-valid.ts — Validates JSON is parseable and has expected top-level shape.

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  try {
    const parsed = JSON.parse(content);
    const isObject = typeof parsed === "object" && parsed !== null;
    const keyCount = isObject ? Object.keys(parsed).length : 0;
    const passed = isObject && keyCount > 0;

    return {
      name: "json-valid",
      passed,
      score: passed ? 1.0 : 0.5,
      reasoning: passed
        ? `Valid JSON object with ${keyCount} top-level keys.`
        : "JSON is parseable but root is not an object or is empty.",
      fix_list: passed ? [] : ["Root should be an object with meaningful keys."],
    };
  } catch (e: any) {
    return {
      name: "json-valid",
      passed: false,
      score: 0,
      reasoning: `JSON parse error: ${e.message}`,
      fix_list: [`Fix JSON syntax: ${e.message.slice(0, 100)}`],
    };
  }
}
