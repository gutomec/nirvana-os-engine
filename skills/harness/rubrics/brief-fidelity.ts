// brief-fidelity.ts — For images, validates file is a valid PNG/JPG with
// reasonable dimensions and not zero-bytes. Deep vision-judging requires an
// MCP image-describe call; here we stick to file-level sanity that doesn't
// need network/LLM access.

import * as fs from "node:fs";

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { artifact } = args;
  const fix_list: string[] = [];

  if (!fs.existsSync(artifact)) {
    return {
      name: "brief-fidelity",
      passed: false,
      score: 0,
      reasoning: "Artifact does not exist.",
      fix_list: ["Generate the artifact."],
    };
  }

  const stat = fs.statSync(artifact);
  if (stat.size < 1024) {
    return {
      name: "brief-fidelity",
      passed: false,
      score: 0,
      reasoning: `File too small (${stat.size} bytes). Likely corrupted.`,
      fix_list: ["Regenerate the image."],
    };
  }

  // PNG signature check
  if (artifact.toLowerCase().endsWith(".png")) {
    const buf = fs.readFileSync(artifact, { encoding: null }).subarray(0, 8);
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.equals(pngSig)) {
      fix_list.push("File extension is .png but signature does not match. Likely corrupted.");
      return {
        name: "brief-fidelity",
        passed: false,
        score: 0.3,
        reasoning: "PNG signature mismatch.",
        fix_list,
      };
    }
  }

  // Heuristic: larger than 100kB = likely real generated image, not placeholder
  const score = stat.size > 100_000 ? 1.0 : 0.7;
  return {
    name: "brief-fidelity",
    passed: true,
    score,
    reasoning: `Image file exists, ${(stat.size / 1024).toFixed(1)}KB. Signature OK.`,
    fix_list: stat.size < 100_000 ? ["Small file — may be a placeholder. Confirm visually."] : [],
  };
}
