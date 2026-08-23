import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute as isPosixAbsolute, resolve, win32 } from "node:path";

export class ServicePathError extends Error {}
export function resolveServiceRef(serviceRoot: string, ref: string, mustExist: boolean): string {
  if (typeof ref !== "string" || !ref || ref.includes("\\") || ref.includes(":") || isPosixAbsolute(ref) || win32.isAbsolute(ref)) throw new ServicePathError("INVALID_SERVICE_REF");
  const segments = ref.split("/"); if (segments.some(segment => !segment || segment === "." || segment === "..")) throw new ServicePathError("INVALID_SERVICE_REF");
  const root = realpathSync.native(serviceRoot), target = resolve(root, ...segments); if (target !== root && !target.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) throw new ServicePathError("ESCAPING_SERVICE_REF");
  let current = root; for (const segment of segments) { current = resolve(current, segment); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ServicePathError("LINKED_SERVICE_REF"); }
  if (mustExist && !existsSync(target)) throw new ServicePathError("MISSING_SERVICE_REF"); return target;
}
