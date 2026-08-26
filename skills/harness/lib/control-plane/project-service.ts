import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PROJECT_SCHEMA_VERSION = "nirvana.project/v1alpha1";
export const PROJECT_MANIFEST = path.join(".nirvana", "project.yaml");

export type ProjectScope = "global" | "project" | "merge";
export type OrchestrationMode = "always" | "on-demand";

export interface Project {
  schema_version: typeof PROJECT_SCHEMA_VERSION;
  project_id: string;
  display_name: string;
  created_at: string;
  lifecycle: "active" | "archived";
  workspace: { workspace_id: string; relative_root: "."; kind: "local" };
  scope: ProjectScope;
  orchestration_mode: OrchestrationMode;
}

export interface ProjectPlan {
  action: "create" | "adopt";
  project_root: string;
  manifest_path: string;
  creates: string[];
  preserves: string[];
  legacy: boolean;
  plan_hash: string;
}

export interface ProjectInput {
  projectRoot: string;
  displayName?: string;
  scope?: ProjectScope;
  orchestrationMode?: OrchestrationMode;
}

function canonicalRoot(input: string): string {
  const resolved = path.resolve(input);
  const parent = fs.realpathSync(path.dirname(resolved));
  return path.join(parent, path.basename(resolved));
}

function manifestPath(root: string): string {
  return path.join(root, PROJECT_MANIFEST);
}

function stablePlan(plan: Omit<ProjectPlan, "plan_hash">): ProjectPlan {
  const plan_hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return { ...plan, plan_hash };
}

export class ProjectService {
  planCreate(input: ProjectInput): ProjectPlan {
    const root = canonicalRoot(input.projectRoot);
    const manifest = manifestPath(root);
    const existing = fs.existsSync(root) ? fs.readdirSync(root) : [];
    return stablePlan({
      action: "create", project_root: root, manifest_path: manifest,
      creates: fs.existsSync(manifest) ? [] : [PROJECT_MANIFEST],
      preserves: existing, legacy: fs.existsSync(path.join(root, ".nirvana")) && !fs.existsSync(manifest),
    });
  }

  planAdoption(input: ProjectInput): ProjectPlan {
    const root = canonicalRoot(input.projectRoot);
    if (!fs.existsSync(root)) throw new Error(`project root does not exist: ${root}`);
    const manifest = manifestPath(root);
    return stablePlan({
      action: "adopt", project_root: root, manifest_path: manifest,
      creates: fs.existsSync(manifest) ? [] : [PROJECT_MANIFEST],
      preserves: fs.readdirSync(root), legacy: fs.existsSync(path.join(root, ".nirvana")) && !fs.existsSync(manifest),
    });
  }

  create(input: ProjectInput, expectedPlanHash?: string): Project {
    return this.materialize(this.planCreate(input), input, expectedPlanHash);
  }

  adopt(input: ProjectInput, expectedPlanHash: string): Project {
    return this.materialize(this.planAdoption(input), input, expectedPlanHash);
  }

  inspect(projectRoot: string): { kind: "project" | "legacy" | "directory" | "missing"; project?: Project; plan?: ProjectPlan } {
    const root = canonicalRoot(projectRoot);
    if (!fs.existsSync(root)) return { kind: "missing" };
    const manifest = manifestPath(root);
    if (fs.existsSync(manifest)) return { kind: "project", project: this.read(root) };
    if (fs.existsSync(path.join(root, ".nirvana"))) return { kind: "legacy", plan: this.planAdoption({ projectRoot: root }) };
    return { kind: "directory", plan: this.planAdoption({ projectRoot: root }) };
  }

  read(projectRoot: string): Project {
    const root = canonicalRoot(projectRoot);
    const file = manifestPath(root);
    const project = JSON.parse(fs.readFileSync(file, "utf8")) as Project;
    if (project.schema_version !== PROJECT_SCHEMA_VERSION || !project.project_id) {
      throw new Error(`unsupported project manifest: ${file}`);
    }
    return project;
  }

  private materialize(plan: ProjectPlan, input: ProjectInput, expectedPlanHash?: string): Project {
    if (expectedPlanHash && expectedPlanHash !== plan.plan_hash) throw new Error("project plan changed; request a new preview");
    if (fs.existsSync(plan.manifest_path)) return this.read(plan.project_root);
    fs.mkdirSync(path.dirname(plan.manifest_path), { recursive: true });
    const project: Project = {
      schema_version: PROJECT_SCHEMA_VERSION,
      project_id: `prj_${randomUUID()}`,
      display_name: input.displayName || path.basename(plan.project_root),
      created_at: new Date().toISOString(), lifecycle: "active",
      workspace: { workspace_id: `wsp_${randomUUID()}`, relative_root: ".", kind: "local" },
      scope: input.scope || "global", orchestration_mode: input.orchestrationMode || "always",
    };
    const temporary = `${plan.manifest_path}.${process.pid}.tmp`;
    // JSON is a strict YAML 1.2 subset. Keeping the manifest JSON-shaped avoids
    // making project creation depend on an installed package while retaining
    // the public, human-readable project.yaml contract.
    fs.writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, plan.manifest_path);
    return project;
  }
}
