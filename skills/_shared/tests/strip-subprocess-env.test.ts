// strip-subprocess-env.test.ts — a squad manifest cannot name the engine's private plumbing.
//
// Measured on 2026-11-17 against this commit: `childEnvFor(env, {mode:
// "declared"})` with a squad that declares `NIRVANA_AUDIT_KEY` in its
// `dependencies.yaml` returned it, because the `NIRVANA_*` / `HARNESS_*` scope
// was added to the allowlist unconditionally. The declared mode exists so a
// squad never sees what it did not declare; naming the engine's paths, its
// state database, its logs root or its audit key is exactly the case it is
// meant to stop: the key is what makes an event read back as engine-provenance.
import { afterEach, describe, expect, test } from "bun:test";
import { childEnvFor } from "../../_shared/lib/child-env.ts";

const parent = {
  PATH: "/usr/bin",
  HOME: "/home/operator",
  ANTHROPIC_API_KEY: "sk-ant-operator",
  NIRVANA_HOME: "/home/operator/.nirvana",
  NIRVANA_AUDIT_KEY: "/home/operator/.nirvana/audit-key",
  NIRVANA_STATE_DB: "/home/operator/.nirvana/state.db",
  NIRVANA_STATE_DIR: "/home/operator/.nirvana",
  HARNESS_LOGS_DIR: "/home/operator/.harness-logs",
  NIRVANA_SKILLS_DIR: "/opt/nirvana/skills",
  NIRVANA_PROJECT_ROOT: "/work/project",
  NIRVANA_TRACE_ID: "run-123",
  NIRVANA_DISPATCH_DEPTH: "1",
};

const savedChildEnv = process.env.NIRVANA_CHILD_ENV;
afterEach(() => {
  if (savedChildEnv === undefined) delete process.env.NIRVANA_CHILD_ENV;
  else process.env.NIRVANA_CHILD_ENV = savedChildEnv;
});

describe("declared child environment", () => {
  test("a squad's declared env_vars do not reach the engine's plumbing", () => {
    // `runtime: "opencode"` is a runtime that legitimately receives
    // ANTHROPIC_API_KEY; it is named here so the assertions below test the
    // declared-environment rule, not the runtime allowlist.
    const env = childEnvFor({ ...parent } as any, {
      mode: "declared",
      runtime: "opencode",
      declared: ["NIRVANA_AUDIT_KEY", "NIRVANA_STATE_DB", "HARNESS_LOGS_DIR", "NIRVANA_TRACE_ID", "ANTHROPIC_API_KEY"],
    });

    // The private surface stays in the engine process.
    expect(env.NIRVANA_AUDIT_KEY).toBeUndefined();
    expect(env.NIRVANA_STATE_DB).toBeUndefined();
    expect(env.HARNESS_LOGS_DIR).toBeUndefined();
    expect(env.NIRVANA_PROJECT_ROOT).toBeUndefined();
    expect(env.NIRVANA_HOME).toBeUndefined();
    expect(env.NIRVANA_SKILLS_DIR).toBeUndefined();
    expect(env.NIRVANA_STATE_DIR).toBeUndefined();
    // What the child genuinely needs still travels: its trace, its depth, the
    // base the OS needs, and the hand-down marker.
    expect(env.NIRVANA_TRACE_ID).toBe("run-123");
    expect(env.NIRVANA_DISPATCH_DEPTH).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NIRVANA_CHILD_ENV).toBe("declared");
  });

  test("the declared mode keeps its purpose: a squad's own declared variable still arrives", () => {
    const env = childEnvFor({ ...parent, STRIPE_API_KEY: "rk_test_own" } as any, {
      mode: "declared",
      runtime: null,
      declared: ["STRIPE_API_KEY"],
    });
    expect(env.STRIPE_API_KEY).toBe("rk_test_own");
  });

  test("NIRVANA_CHILD_ENV_EXTRA is the owner's door, and it still opens for a non-credential name", () => {
    const env = childEnvFor({ ...parent, MY_CORP_BUCKET: "s3://corp" } as any, {
      mode: "declared",
      runtime: "codex",
      declared: [],
    });
    expect(env.MY_CORP_BUCKET).toBeUndefined();
    const widened = childEnvFor({ ...parent, MY_CORP_BUCKET: "s3://corp", NIRVANA_CHILD_ENV_EXTRA: "MY_CORP_BUCKET" } as any, {
      mode: "declared",
      runtime: "codex",
      declared: [],
    });
    expect(widened.MY_CORP_BUCKET).toBe("s3://corp");
  });

  test("inherit is untouched: a caller that asks for the whole environment gets it", () => {
    const env = childEnvFor({ ...parent } as any, { mode: "inherit" });
    expect(env.NIRVANA_AUDIT_KEY).toBe(parent.NIRVANA_AUDIT_KEY);
    expect(env.HARNESS_LOGS_DIR).toBe(parent.HARNESS_LOGS_DIR);
  });
});