export class StrictJsonError extends Error {}

export function parseStrictJson(bytes: Uint8Array): unknown {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch (cause) { throw new StrictJsonError("INVALID_UTF8", { cause }); }
  if (source.charCodeAt(0) === 0xfeff) throw new StrictJsonError("BOM_NOT_ALLOWED");
  let index = 0;
  const space = () => { while (/\s/.test(source[index] ?? "")) index++; };
  const fail = (reason: string): never => { throw new StrictJsonError(reason); };
  const string = (): string => {
    if (source[index++] !== '"') fail("STRING_EXPECTED");
    let value = '"'; let escaped = false;
    while (index < source.length) { const character = source[index++]; value += character; if (!escaped && character === '"') { try { return JSON.parse(value); } catch (cause) { throw new StrictJsonError("INVALID_STRING", { cause }); } } if (!escaped && character < " ") fail("CONTROL_CHARACTER"); escaped = !escaped && character === "\\"; if (escaped && character !== "\\") escaped = false; }
    return fail("UNTERMINATED_STRING");
  };
  const value = (): void => {
    space(); const character = source[index];
    if (character === '"') { string(); return; }
    if (character === "{") { index++; space(); const keys = new Set<string>(); if (source[index] === "}") { index++; return; } while (true) { space(); if (source[index] !== '"') fail("OBJECT_KEY_EXPECTED"); const key = string(); if (keys.has(key)) fail("DUPLICATE_KEY"); keys.add(key); space(); if (source[index++] !== ":") fail("COLON_EXPECTED"); value(); space(); if (source[index] === "}") { index++; return; } if (source[index++] !== ",") fail("COMMA_EXPECTED"); } }
    if (character === "[") { index++; space(); if (source[index] === "]") { index++; return; } while (true) { value(); space(); if (source[index] === "]") { index++; return; } if (source[index++] !== ",") fail("COMMA_EXPECTED"); } }
    const literal = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)?.[0];
    if (!literal) fail("VALUE_EXPECTED"); index += literal.length;
  };
  value(); space(); if (index !== source.length) fail("TRAILING_DATA");
  try { return JSON.parse(source); } catch (cause) { throw new StrictJsonError("INVALID_JSON", { cause }); }
}
