#!/usr/bin/env node
/**
 * Generate platform-specific agent definitions from roles/*.md.
 * Outputs are committed; --check verifies no drift without writing.
 *
 * Usage:
 *   node bin/generate-agents.mjs           # write agents/*.md and generated-pi/*.md
 *   node bin/generate-agents.mjs --check   # exit 1 on drift, write nothing
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS, ROSTER, parseRole } from "../lib/platforms.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const rolesDir = path.join(pkgRoot, "roles");

const checkOnly = process.argv.includes("--check");
let drift = false;

for (const id of ROSTER) {
  const roleFile = path.join(rolesDir, `${id}.md`);
  if (!fs.existsSync(roleFile)) {
    console.error(`missing role file: roles/${id}.md`);
    process.exitCode = 1;
    continue;
  }
  const meta = parseRole(fs.readFileSync(roleFile, "utf8"));

  for (const [platform, spec] of Object.entries(PLATFORMS)) {
    const outRel = spec.outPath(id);
    const outFile = path.join(pkgRoot, outRel);
    const content = spec.frontmatter(meta) + meta.body.trimEnd() + "\n";
    if (checkOnly) {
      const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;
      if (current !== content) {
        console.error(`drift: ${outRel} does not match roles/${id}.md`);
        drift = true;
      }
    } else {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, content);
      console.log(`wrote ${outRel} (${platform})`);
    }
  }
}

// Unknown extra role files must not silently rot.
for (const dir of ["roles"]) {
  const extra = fs.readdirSync(path.join(pkgRoot, dir)).filter(
    (f) => f.endsWith(".md") && !ROSTER.includes(f.replace(/\.md$/, "")),
  );
  if (extra.length) {
    console.error(`unmapped role files in ${dir}/: ${extra.join(", ")}`);
    process.exitCode = 1;
  }
}

if (drift) {
  console.error("run: node bin/generate-agents.mjs");
  process.exitCode = 1;
}
