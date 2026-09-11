// ensure-dir.ts — typed face of ensure-dir.js. The implementation is CJS so the
// canonical audit emitter (harness/lib/audit.js) can require() it directly.
import * as impl from "./ensure-dir.js";

/** `mkdir -p` that treats EEXIST as success (Bun on Windows throws it). */
export const ensureDir: (dir: string) => string = impl.ensureDir;

/** Whether an error means "the directory is already there". */
export const isAlreadyExists: (e: unknown) => boolean = impl.isAlreadyExists;
