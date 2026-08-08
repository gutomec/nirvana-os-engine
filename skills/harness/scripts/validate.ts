#!/usr/bin/env bun
/**
 * validate.ts — harness self-test.
 *
 * Delegates to the real system diagnostic (doctor-system.ts), which checks
 * binaries, the skills tree, registry freshness, and wired hooks, and exits
 * non-zero when something is broken. (Previously this called a `validate`
 * entrypoint on registry-loader.js that does not exist, so it was a silent
 * no-op that always exited 0.)
 *
 * Streams the diagnostic straight through (stdio inherit) so the user sees the
 * report and the real exit code propagates.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { paths } from "../../_shared/lib/bun-helpers.ts";

const doctor = path.join(paths.CLAUDE_SKILLS_DIR, "harness", "scripts", "doctor-system.ts");
const r = spawnSync(process.execPath, [doctor, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
