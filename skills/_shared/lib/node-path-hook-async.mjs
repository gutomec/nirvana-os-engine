// node-path-hook-async.mjs — the async resolve hook node-path-hook.mjs
// registers through module.register on a Node without module.registerHooks.
// Same rule: a bare specifier the normal resolution cannot find is resolved
// again from inside each NODE_PATH entry.
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const roots = (process.env.NODE_PATH || "").split(delimiter).filter(Boolean);
const isBare = (s) => !/^(\.{0,2}[\\/]|[a-zA-Z][a-zA-Z\d+.-]*:|#|\/)/.test(s);
const parentIn = (root) => pathToFileURL(join(root, "..", "noop.js")).href;

export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND" || !isBare(specifier)) throw e;
    for (const root of roots) {
      try { return await next(specifier, { ...context, parentURL: parentIn(root) }); } catch { /* next root */ }
    }
    throw e;
  }
}
