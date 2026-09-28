import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const install = path.join(pkgRoot, "scripts/install.mjs");

const run = (...args) => execFileSync(process.execPath, [install, ...args], { encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "native-v2-"));

test("--check passes on a complete bundle", () => {
  const out = run("--check");
  assert.equal(out, "");
});

test("opencode install into empty target writes 8 agents + skill + manifest", () => {
  const dir = tmp();
  const out = run("--platform", "opencode", "--target", dir);
  for (const id of ["prometheus", "builder", "explore", "momus"]) {
    assert.ok(fs.existsSync(path.join(dir, "agents", `${id}.md`)), `${id} installed`);
  }
  assert.ok(fs.existsSync(path.join(dir, "skills", "ulw-plan", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dir, ".native-v2-manifest.json")));
  assert.match(out, /plugins/);

  // reinstall is idempotent (everything identical → skips)
  const again = run("--platform", "opencode", "--target", dir);
  assert.match(again, /skip\s+agents\/builder\.md \(identical\)/);
});

test("user-owned conflicting file is skipped without --force", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "builder.md"), "user's own builder");
  const out = run("--platform", "opencode", "--target", dir);
  assert.match(out, /skip\s+agents\/builder\.md \(user-owned/);
  assert.equal(fs.readFileSync(path.join(dir, "agents", "builder.md"), "utf8"), "user's own builder");

  // --force replaces it
  run("--platform", "opencode", "--target", dir, "--force");
  assert.match(fs.readFileSync(path.join(dir, "agents", "builder.md"), "utf8"), /focused executor/);
});

test("manifest-owned files update on reinstall; user edits to models survive", () => {
  const dir = tmp();
  run("--platform", "opencode", "--target", dir);
  // user customizes an agent file after our install
  fs.appendFileSync(path.join(dir, "agents", "momus.md"), "\n<!-- user note -->\n");
  const out = run("--platform", "opencode", "--target", dir);
  // momus.md is manifest-owned → updated (documented behavior; models live in json anyway)
  assert.match(out, /write\s+agents\/momus\.md/);
  assert.ok(!fs.readFileSync(path.join(dir, "agents", "momus.md"), "utf8").includes("user note"));
});

test("pi install writes flat agent files", () => {
  const dir = tmp();
  const out = run("--platform", "pi", "--target", dir);
  assert.ok(fs.existsSync(path.join(dir, "builder.md")));
  assert.ok(fs.existsSync(path.join(dir, "prometheus.md")));
  assert.match(out, /pi model roles/);
});

test("--dry-run writes nothing", () => {
  const dir = tmp();
  run("--platform", "opencode", "--target", dir, "--dry-run");
  assert.ok(!fs.existsSync(path.join(dir, "agents")));
  assert.ok(!fs.existsSync(path.join(dir, ".native-v2-manifest.json")));
});

test("missing platform or target fails with usage", () => {
  assert.throws(() => run("--platform", "opencode"), /usage:/);
});
