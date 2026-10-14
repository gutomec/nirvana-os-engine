// fake-typesafe-server.ts — fake-typesafe.ts as its own process, for callers
// that block the test's event loop (jevCallSync's spawnSync). Answers every
// question from FAKE_TS_ANSWERS (JSON, question key → answer; unknown keys get
// `none`), appends each request body to FAKE_TS_LOG, prints its URL on stdout.
import * as fs from "node:fs";
import { answering, startFakeTypesafe } from "./fake-typesafe.ts";

const table = JSON.parse(process.env.FAKE_TS_ANSWERS || "{}");
const log = process.env.FAKE_TS_LOG;
const fake = startFakeTypesafe((body) => {
  if (log) fs.appendFileSync(log, JSON.stringify(body) + "\n");
  return answering(table)(body);
});
console.log(fake.url);
await new Promise(() => {});
