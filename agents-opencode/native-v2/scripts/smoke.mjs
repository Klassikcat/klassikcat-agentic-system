#!/usr/bin/env node
/**
 * Host smoke: verify real OpenCode registration for the native-v2 bundle.
 *
 * Verified recipe (opencode v2.0.x): a throwaway project under $HOME (config
 * discovery does not boot under /tmp on this host), `opencode serve --port`,
 * then POLL until the location finishes booting — agents appear
 * asynchronously several seconds after "server listening". `opencode api
 * --server` handles auth. No model calls: registration/config verification
 * only; plan_graph semantics are covered by unit tests.
 *
 * Usage: node scripts/smoke.mjs [--keep]
 * Exit 0 = all checks passed; 1 = failed checks; 2 = BLOCKED (host issue).
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = ["prometheus", "explore", "librarian", "metis", "momus", "oracle", "multimodal-looker", "builder"];
// Port servers since opencode v2.0.18 restart with password auth; pin one for
// both the server and the `opencode api --server` client calls below.
const SERVER_PASSWORD = `native-v2-${process.pid}`;
process.env.OPENCODE_PASSWORD = SERVER_PASSWORD;

const keep = process.argv.includes("--keep");
// Under $HOME: /tmp locations do not boot config discovery on this host.
const project = fs.mkdtempSync(path.join(os.homedir(), ".native-v2-smoke-"));
const port = 14100 + (process.pid % 400);
const oc = path.join(project, ".opencode");
fs.mkdirSync(path.join(oc, "agents"), { recursive: true });

for (const id of ROSTER) {
  fs.copyFileSync(path.join(pkgRoot, "agents", `${id}.md`), path.join(oc, "agents", `${id}.md`));
}
fs.cpSync(path.join(pkgRoot, "skills", "ulw-plan"), path.join(oc, "skills", "ulw-plan"), { recursive: true });
fs.writeFileSync(
  path.join(oc, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [path.join(pkgRoot, "plugin")],
      agents: { builder: { model: "openai/gpt-6-luna#max" } },
    },
    null,
    2,
  ),
);

const server = spawn("opencode", ["serve", "--port", String(port)], {
  cwd: project,
  stdio: "ignore",
  detached: true,
  env: { ...process.env, OPENCODE_PASSWORD: SERVER_PASSWORD },
});
const base = `http://127.0.0.1:${port}`;

async function api(method, p) {
  const { stdout } = await run("opencode", ["api", "--server", base, method, p]);
  return JSON.parse(stdout);
}

function cleanup() {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  if (!keep) fs.rmSync(project, { recursive: true, force: true });
}
process.on("exit", cleanup);

const failures = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

async function waitUntilBooted(timeoutMs = 90_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const d = await api("get", "/api/agent");
      last = d;
      if ((d.data ?? []).length > 0) return d;
    } catch {
      /* server not accepting yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

try {
  console.log(`project: ${project}\nserver:  ${base}\n`);
  const agents = (await waitUntilBooted()) ?? { data: [] };
  const list = agents.data ?? [];
  if (list.length === 0) {
    console.error("BLOCKED: location never finished booting (no agents at all after 90s)");
    cleanup();
    process.exit(2);
  }
  const byId = new Map(list.map((a) => [a.id, a]));

  for (const id of ROSTER) {
    const a = byId.get(id);
    check(`agent registered: ${id}`, Boolean(a));
    if (!a) continue;
    const mode = a.mode;
    const expected = id === "prometheus" ? "primary" : "subagent";
    check(`  ${id} mode ${expected}`, mode === expected, `got ${mode}`);
  }

  const builder = byId.get("builder");
  const bModel = builder?.model;
  const bModelId = typeof bModel === "object" && bModel ? bModel.id : bModel;
  check("builder model from json (gpt-6-luna)", bModelId === "gpt-6-luna", JSON.stringify(bModel));

  const expectedDeny = ["explore", "librarian", "metis", "momus", "oracle", "multimodal-looker"];
  for (const id of expectedDeny) {
    const perms = byId.get(id)?.permissions ?? [];
    const eff = (act) => perms.filter((p) => p.action === act).map((p) => p.effect);
    check(`  ${id} denies edit+shell+subagent`, eff("edit").includes("deny") && eff("shell").includes("deny") && eff("subagent").includes("deny"));
  }

  const prom = byId.get("prometheus");
  const promPerms = prom?.permissions ?? [];
  const hasPlanException = promPerms.some(
    (p) => p.action === "edit" && String(p.resource).includes(".omo") && p.effect === "allow",
  );
  check("prometheus edit deny with .omo/** exception", hasPlanException);
  check(
    "prometheus denies builder subagent",
    promPerms.some((p) => p.action === "subagent" && p.resource === "builder" && p.effect === "deny"),
  );

  const skills = await api("get", "/api/skill");
  const skillIds = (skills.data ?? []).map((s) => s.id ?? s.name);
  check("skill ulw-plan discovered", skillIds.some((s) => String(s).endsWith("ulw-plan")), skillIds.filter((s) => String(s).includes("ulw")).join(","));

  const plugins = await api("get", "/api/plugin");
  const pluginIds = (plugins.data ?? []).map((p) => p.id ?? p.name);
  check("plugin native-v2-plan-graph loaded", pluginIds.includes("native-v2-plan-graph"), `got ${pluginIds.length} plugins`);
} catch (err) {
  console.error(`BLOCKED: ${err.message}`);
  cleanup();
  process.exit(2);
}

cleanup();
if (keep) console.log(`kept: ${project}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nhost smoke: all checks passed");
