import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROSTER } from "../lib/platforms.mjs";

const pkgRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");

const read = (rel) => fs.readFileSync(path.join(pkgRoot, rel), "utf8");
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "frontmatter missing");
  return m[1];
};

test("roster is exactly the eight agreed agents", () => {
  assert.deepEqual([...ROSTER].sort(), [
    "builder",
    "explore",
    "librarian",
    "metis",
    "momus",
    "multimodal-looker",
    "oracle",
    "prometheus",
  ]);
});

test("opencode agents: modes, read-only denies, builder grants, no models in md", () => {
  for (const id of ROSTER) {
    const fm = frontmatter(read(`agents/${id}.md`));
    if (id === "prometheus") {
      assert.match(fm, /^mode: primary$/m, `${id} must be primary`);
      // plan-artifact exception after the broad deny (last match wins)
      const denyIdx = fm.indexOf('action: edit');
      assert.match(fm, /effect: deny[\s\S]*?resource: "\.omo\/\*\*"[\s\S]*?effect: allow/m);
      assert.ok(denyIdx >= 0);
      assert.match(fm, /resource: "builder"[\s\S]*?effect: deny/m, "prometheus must deny builder");
    } else {
      assert.match(fm, /^mode: subagent$/m, `${id} must be subagent`);
      if (id === "builder") {
        assert.match(fm, /action: edit[\s\S]*?effect: allow/m);
      } else {
        assert.match(fm, /action: edit[\s\S]*?effect: deny/m, `${id} must deny edit`);
        assert.match(fm, /action: shell[\s\S]*?effect: deny/m, `${id} must deny shell`);
      }
      assert.match(fm, /action: subagent[\s\S]*?effect: deny/m, `${id} must deny subagent`);
    }
    assert.match(fm, /^model: \S+\/\S+/m, `${id}.md carries its default model (JSON agents.<id>.model overrides in stock setups)`);
    assert.match(fm, /^description: \S/m, `${id} needs a description`);
  }
});

test("opencode agents: prompts carry the core lightweight invariants", () => {
  const bodies = Object.fromEntries(ROSTER.map((id) => [id, read(`agents/${id}.md`)]));
  // delegation ban wording for all subagents
  for (const id of ROSTER) {
    if (id === "prometheus") continue;
    const body = bodies[id].replace(/^---[\s\S]*?---\n/, "");
    if (id === "builder") assert.match(body, /never spawn further agents|never delegate/i);
  }
  // truthful verification vocabulary in builder
  const builder = bodies.builder;
  for (const s of ["PASS", "FAIL", "SKIPPED", "BLOCKED"]) assert.ok(builder.includes(s));
  assert.match(builder, /smallest coherent change/i);
  // prometheus: plans-only + read-only delegation + DAG tool
  const prom = bodies.prometheus;
  assert.match(prom, /never implement/i);
  assert.match(prom, /plan_graph/i);
  assert.match(prom, /never calls builder|never spawn.*builder|Never `builder`/i);
  // momus: input contract + blocker-only + cap
  const momus = bodies.momus;
  assert.match(momus, /\.omo\/plans\//);
  assert.match(momus, /OKAY/);
  assert.match(momus, /max(imum)? 3/i);
});

test("pi agents: frontmatter, tools, and read-only grants", () => {
  for (const id of ROSTER) {
    const fm = frontmatter(read(`generated-pi/${id}.md`));
    assert.match(fm, new RegExp(`^name: ${id}$`, "m"));
    assert.match(fm, /^model: pi\//m, `${id} needs a pi model role`);
    if (id !== "builder" && id !== "prometheus") {
      assert.doesNotMatch(fm, /^tools: .*\b(edit|write|bash)\b/m, `${id} must not edit/write/bash`);
    }
    if (id === "librarian") assert.match(fm, /^tools: .*web_search/m);
    if (id === "multimodal-looker") assert.match(fm, /^tools: read$/m);
  }
});

test("generated files have no drift from roles", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run(process.execPath, [path.join(pkgRoot, "bin/generate-agents.mjs"), "--check"]);
});

test("no bundled prompt references unavailable OMO tool names", () => {
  for (const id of ROSTER) {
    const body = read(`agents/${id}.md`).replace(/^---[\s\S]*?---\n/, "");
    for (const gone of ["call_omo_agent", "lsp_diagnostics", "todowrite", "task_create", "background_output", "look_at"]) {
      assert.ok(!body.includes(gone), `${id} references OMO-only tool ${gone}`);
    }
  }
});
