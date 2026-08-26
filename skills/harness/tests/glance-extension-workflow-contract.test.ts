import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const workflowPath = join(import.meta.dir, "../../../.github/workflows/smoke.yml");

const requiredBrowserScript = [
  '$Candidates = switch ("${{ runner.os }}") {',
  '  "Linux"   { @("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser") }',
  '  "macOS"   { @("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge") }',
  '  "Windows" { @("$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe", "${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe") }',
  '  default   { throw "Unsupported runner OS: ${{ runner.os }}" }',
  '}',
  '$Browser = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1',
  'if (-not $Browser) { throw "Required Chrome, Chromium, or Edge executable is absent" }',
  '"GLANCE_TEST_BROWSER=$Browser" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append',
  '& $Browser --version',
].join("\n");

test("EXT-WORKFLOW-REQUIRES-REAL-BROWSER runs the exact local-only browser contract before the whole suite on three OSes", () => {
  const source = readFileSync(workflowPath, "utf8");
  const workflow = parseYaml(source) as any;
  const smoke = workflow.jobs.smoke;
  expect(smoke.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);

  const steps = smoke.steps as Array<Record<string, unknown>>;
  const browserIndex = steps.findIndex((step) => step.name === "Resolve required local browser");
  const suiteIndex = steps.findIndex((step) => step.run === "bun test skills");
  expect(browserIndex).toBeGreaterThan(-1);
  expect(suiteIndex).toBeGreaterThan(browserIndex);

  const browserStep = steps[browserIndex]!;
  const suiteStep = steps[suiteIndex]!;
  expect(browserStep.shell).toBe("pwsh");
  expect(String(browserStep.run).trim()).toBe(requiredBrowserScript);
  expect(browserStep).not.toHaveProperty("if");
  expect(browserStep).not.toHaveProperty("continue-on-error");
  expect(suiteStep).not.toHaveProperty("if");
  expect(suiteStep).not.toHaveProperty("continue-on-error");

  const requiredPath = steps.slice(browserIndex, suiteIndex + 1);
  const requiredPathText = JSON.stringify(requiredPath).toLowerCase();
  expect(requiredPathText).not.toMatch(/https?:\/\//);
  expect(requiredPathText).not.toMatch(/playwright|puppeteer|download|fallback|mock|skip/);
});
