export function canonicalizeJcs(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return Object.is(value, -0) ? "0" : String(value);
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(entry => canonicalizeJcs(entry)).join(",")}]`;
  if (type === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalizeJcs(source[key])}`).join(",")}}`;
  }
  throw new TypeError("JCS_NON_SERIALIZABLE_VALUE");
}
