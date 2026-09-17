// secret-leak.ts — a deliverable never carries a secret out.
//
// Fails (the delivery is withheld) when the artifact contains the exact value
// of a secret this process can see: a credential-like environment variable, or
// a line of the dotenv files the engine's configuration chain and the project
// use. Passes with a reservation when the artifact only LOOKS like it carries a
// credential (a private-key block, a vendor token prefix, a dump of KEY=value
// lines): documentation and `.env.example` files are shaped like that on
// purpose, so the shape alone is redacted downstream, never withheld here.
// Findings name variables, never values.
import { defaultDotenvFiles, knownSecrets, scanText } from "../../_shared/lib/secret-scan.ts";

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  const known = knownSecrets({ env: process.env, dotenvFiles: defaultDotenvFiles({ cwd: process.cwd(), projectRoot: process.env.NIRVANA_PROJECT_ROOT ?? null }) });
  const findings = scanText(content, known);
  const blocking = findings.filter((f) => f.kind === "known") as Array<{ kind: "known"; name: string }>;
  const shaped = findings.filter((f) => f.kind !== "known") as Array<{ kind: string; label: string }>;
  if (blocking.length) {
    const names = [...new Set(blocking.map((f) => f.name))];
    return {
      name: "secret-leak",
      passed: false,
      score: 0,
      reasoning: `The artifact contains the value of ${names.length === 1 ? "a secret" : `${names.length} secrets`} this machine holds: ${names.join(", ")}. A deliverable must not carry credentials.`,
      fix_list: names.map((n) => `Remove the value of ${n} from the artifact (refer to it by name, or leave it out).`),
    };
  }
  if (shaped.length) {
    return {
      name: "secret-leak",
      passed: true,
      score: 0.8,
      reasoning: `No known secret value, but credential-shaped content: ${shaped.map((f) => f.label).join("; ")}. Redacted on the way out; confirm it is example material.`,
      fix_list: [],
    };
  }
  return { name: "secret-leak", passed: true, score: 1, reasoning: "No secret value and no credential-shaped content.", fix_list: [] };
}
