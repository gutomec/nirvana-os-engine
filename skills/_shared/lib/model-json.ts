// model-json.ts — the typed face of model-json.js. The implementation lives in
// the CJS sibling so `skills/squads/lib/*.js` can require() it without crossing
// the ESM boundary Windows enforces as a hard error. See that file for why the
// greedy `/\{[\s\S]*\}/` this replaces was a defect on every runtime that wraps
// its answer in an event stream.
import * as impl from "./model-json.js";

export const jsonObjectsIn: (text: string) => any[] = impl.jsonObjectsIn;
export const extractJsonObject: <T = any>(text: string, accept?: (value: any) => boolean) => T | null = impl.extractJsonObject;
export const extractJsonWithKeys: <T = any>(text: string, keys: string | string[]) => T | null = impl.extractJsonWithKeys;
