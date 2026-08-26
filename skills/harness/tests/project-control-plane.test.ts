import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConversationService, ProjectService } from "../lib/control-plane/index.ts";

const roots: string[] = [];
function temporaryRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `nrv-${name}-`));
  roots.push(root);
  return root;
}
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("ProjectService", () => {
  test("plans without writes and adopts only with the current plan hash", () => {
    const root = temporaryRoot("legacy");
    fs.mkdirSync(path.join(root, ".nirvana"));
    fs.writeFileSync(path.join(root, "custom.txt"), "preserve me", "utf8");
    const service = new ProjectService();
    const plan = service.planAdoption({ projectRoot: root, scope: "merge" });
    expect(plan.legacy).toBe(true);
    expect(fs.existsSync(path.join(root, ".nirvana", "project.yaml"))).toBe(false);
    expect(() => service.adopt({ projectRoot: root }, "stale")).toThrow(/plan changed/);
    const project = service.adopt({ projectRoot: root, scope: "merge" }, plan.plan_hash);
    expect(project.project_id).toStartWith("prj_");
    expect(fs.readFileSync(path.join(root, "custom.txt"), "utf8")).toBe("preserve me");
    expect(service.create({ projectRoot: root }).project_id).toBe(project.project_id);
  });

  test("keeps identity stable when the workspace moves", () => {
    const parent = temporaryRoot("move");
    const first = path.join(parent, "first");
    const second = path.join(parent, "second");
    fs.mkdirSync(first);
    const service = new ProjectService();
    const id = service.create({ projectRoot: first }).project_id;
    fs.renameSync(first, second);
    expect(service.read(second).project_id).toBe(id);
  });
});

describe("ConversationService", () => {
  test("persists isolated conversations and ordered messages across restart", () => {
    const root = temporaryRoot("conversation");
    const dbPath = path.join(root, ".nirvana", "control-plane.sqlite");
    let service = new ConversationService(dbPath);
    service.create("prj_a", "Nova conversa", "cnv_a");
    service.create("prj_b", "Other", "cnv_b");
    service.append({ conversationId: "cnv_a", projectId: "prj_a", role: "user", content: "Primeira mensagem" });
    service.append({ conversationId: "cnv_a", projectId: "prj_a", role: "assistant", content: "Resposta" });
    expect(() => service.append({ conversationId: "cnv_a", projectId: "prj_b", role: "user", content: "intrusion" })).toThrow(/does not belong/);
    service.close();
    service = new ConversationService(dbPath);
    expect(service.list("prj_a").map(item => item.conversation_id)).toEqual(["cnv_a"]);
    expect(service.messages("cnv_a").map(item => [item.sequence, item.content])).toEqual([[1, "Primeira mensagem"], [2, "Resposta"]]);
    service.close();
  });
});
