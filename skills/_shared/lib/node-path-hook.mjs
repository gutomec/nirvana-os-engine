// node-path-hook.mjs — NODE_PATH for Node's ESM loader.
//
// A squad's packages live in its environment (~/.nirvana/envs/<slug>, see
// squad-env.ts), never in the squad folder, and the worker reaches them through
// NODE_PATH. Bun honours NODE_PATH for `import` and `require` alike, and so
// does Node's CommonJS `require`; Node's ESM loader ignores it, so
// `node scripts/render.mjs` would fail on a package that is plainly installed.
//
// Loaded with `NODE_OPTIONS=--import=<file URL of this file>` (squadRunEnv), it
// adds one fallback: a bare specifier the normal resolution cannot find is
// resolved again as if imported from inside each NODE_PATH entry, which keeps
// `exports` maps and conditions working. Everything else is untouched.
//
// module.registerHooks (Node 22.15+, 23.5+) runs in-thread and is what Node 26
// asks for; module.register (Node 20.6+) is the fallback, through the async
// twin of these hooks in node-path-hook-async.mjs.
import * as mod from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const roots = (process.env.NODE_PATH || "").split(delimiter).filter(Boolean);
/** `pkg`, `@scope/pkg/sub`: not relative, absolute, a URL, a `node:` builtin or a `#` import. */
const isBare = (s) => !/^(\.{0,2}[\\/]|[a-zA-Z][a-zA-Z\d+.-]*:|#|\/)/.test(s);
const parentIn = (root) => pathToFileURL(join(root, "..", "noop.js")).href;

if (roots.length && typeof mod.registerHooks === "function") {
  mod.registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (e) {
        if (e?.code !== "ERR_MODULE_NOT_FOUND" || !isBare(specifier)) throw e;
        for (const root of roots) {
          try { return next(specifier, { ...context, parentURL: parentIn(root) }); } catch { /* next root */ }
        }
        throw e;
      }
    },
  });
} else if (roots.length && typeof mod.register === "function") {
  mod.register(new URL("./node-path-hook-async.mjs", import.meta.url));
}
