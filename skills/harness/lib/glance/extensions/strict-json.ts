import { parseJsonWithDuplicateKeyRejection } from "./strict-json-parser.ts";

export function parseStrictJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SyntaxError("UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) throw new SyntaxError("BOM");
  if (text.includes("\r")) throw new SyntaxError("LF_ONLY");
  return parseJsonWithDuplicateKeyRejection(text, {
    maxDepth: 64,
    rejectTrailing: true,
    rejectLoneSurrogates: true,
    rejectNonFinite: true,
    rejectLeadingZero: true,
  });
}
