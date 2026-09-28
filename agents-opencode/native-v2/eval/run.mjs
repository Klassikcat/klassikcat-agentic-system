#!/usr/bin/env node
/**
 * A/B evaluation runner: lean (installed agents) vs baseline (upstream-extract
 * prompts) on the same harness, models, and fixtures.
 *
 *   node eval/run.mjs --dry-run                 (default; free: validates cases, baselines, fixtures)
 *   node eval/run.mjs --execute --max-runs 4 --max-cost-usd 2 --out <dir>   (paid; both params REQUIRED)
 *   --builder-model provider/model[#variant]    (default openai/gpt-6-luna#max; applies to BOTH arms)
 *
 * Suites: pilot = 2 selected cases × arms; confirm = all 18 cases × arms.
 * Arms:   baseline swaps agents/<role>.md with eval/baselines/<role>.md; lean
 *         uses the generated agents as-is. builder runs gpt-6-luna#max in both.
 * Output: <out>/results.json (+ raw transcripts via session ids) consumed by
 *         eval/report.mjs. Budget exhaustion ⇒ BLOCKED/INCOMPLETE, never PASS.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = ["prometheus", "explore", "librarian", "metis", "momus", "oracle", "multimodal-looker", "builder"];
const PILOT_CASES = ["explore-normal", "builder-simple"];
// Port servers since opencode v2.0.18 restart with password auth; pin one for
// both the server and the `opencode api --server` client calls below.
const SERVER_PASSWORD = `native-v2-eval-${process.pid}`;
process.env.OPENCODE_PASSWORD = SERVER_PASSWORD;

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n) => process.argv.includes(`--${n}`);

const execute = flag("execute");
const suite = arg("suite") ?? "pilot";
const armSel = arg("arm") ?? "both";
const builderModel = arg("builder-model") ?? "openai/gpt-6-luna#max";
const maxRuns = Number(arg("max-runs") ?? 0);
const maxCost = Number(arg("max-cost-usd") ?? 0);
const outDir = path.resolve(arg("out") ?? path.join("/tmp/opencode/native-v2-eval", new Date().toISOString().replace(/[:.]/g, "-")));

const cases = JSON.parse(fs.readFileSync(path.join(pkgRoot, "eval/cases.json"), "utf8")).cases;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/* ---------- validation (free) ---------- */
function validate() {
  const errs = [];
  const ids = new Set();
  for (const c of cases) {
    if (!c.id || ids.has(c.id)) errs.push(`bad/duplicate case id ${c.id}`);
    ids.add(c.id);
    if (!ROSTER.includes(c.role)) errs.push(`case ${c.id}: unknown role ${c.role}`);
    if (!["normal", "negative"].includes(c.kind)) errs.push(`case ${c.id}: kind must be normal|negative`);
    if (!c.prompt || !c.expect) errs.push(`case ${c.id}: needs prompt + expect`);
  }
  // Coverage: every role has a normal+negative pair, except builder (4) / prometheus (2).
  for (const r of ROSTER) {
    const mine = cases.filter((c) => c.role === r);
    if (r === "builder" || r === "prometheus") {
      if (mine.length < 2) errs.push(`role ${r}: expected >=2 cases, got ${mine.length}`);
    } else if (mine.length !== 2 || !mine.some((c) => c.kind === "normal") || !mine.some((c) => c.kind === "negative")) {
      errs.push(`role ${r}: expected one normal + one negative case`);
    }
  }
  for (const r of ROSTER) {
    const f = path.join(pkgRoot, "eval/baselines", `${r}.md`);
    if (!fs.existsSync(f) || fs.statSync(f).size < 200) errs.push(`baseline missing/too small: eval/baselines/${r}.md`);
    const lean = path.join(pkgRoot, "agents", `${r}.md`);
    if (!fs.existsSync(lean)) errs.push(`lean agent missing: agents/${r}.md`);
  }
  const fx = path.join(pkgRoot, "eval/fixtures");
  for (const d of ["mini-project", "mini-project-failing", "mini-project-dirty"]) {
    if (!fs.existsSync(path.join(fx, d, "test/math.test.js"))) errs.push(`fixture missing: ${d}`);
  }
  for (const f of ["momus-valid-plan.md", "momus-broken-plan.md", "flow-diagram.png"]) {
    if (!fs.existsSync(path.join(fx, f))) errs.push(`fixture missing: ${f}`);
  }
  return errs;
}

/* ---------- paid execution ---------- */
async function api(base, method, p, data) {
  const args = ["api", "--server", base, method, p];
  if (data) args.push("--data", JSON.stringify(data));
  const { stdout } = await run("opencode", args, { maxBuffer: 64 * 1024 * 1024 });
  const body = stdout.trim();
  if (!body) return null; // 204-style endpoints: switchAgent, wait, reload
  return JSON.parse(body);
}

async function collectTree(base, rootID) {
  // Sum tokens/cost across the root session and its descendants.
  const all = (await api(base, "get", "/api/session")).data ?? [];
  const tree = all.filter((s) => s.id === rootID || s.parentID === rootID).map((s) => s.id);
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  let cost = 0;
  let toolCalls = 0;  const models = new Set();
  let complete = true;
  for (const sid of tree) {
    let ctx;
    try {
      ctx = await api(base, "get", `/api/session/${sid}/context`);
    } catch {
      complete = false;
      continue;
    }
    for (const m of ctx.data ?? []) {
      if (m.type !== "assistant") continue;
      if (m.model?.id) models.add(`${m.model.providerID}/${m.model.id}${m.model.variant ? `#${m.model.variant}` : ""}`);
      const t = m.tokens;
      if (!t) {
        complete = false;
        continue;
      }
      tokens.input += t.input ?? 0;
      tokens.output += t.output ?? 0;
      tokens.reasoning += t.reasoning ?? 0;
      tokens.cache_read += t.cache?.read ?? 0;
      tokens.cache_write += t.cache?.write ?? 0;
      cost += m.cost ?? 0;
      toolCalls += (m.content ?? []).filter((c) => c.type === "tool").length;
    }
  }
  return { sessions: tree, tokens, cost, toolCalls, models: [...models], complete };
}

function parseModelRef(ref) {
  const [providerID, rest] = String(ref).split("/");
  const [id, variant] = (rest ?? "").split("#");
  return variant ? { providerID, id, variant } : { providerID, id };
}

/** Point fixture references at the throwaway project, not the repo originals. */
function buildPrompt(c, project) {
  if (c.fixture?.startsWith("mini-project")) {
    const abs = path.join(pkgRoot, "eval/fixtures", c.fixture);
    return c.prompt.split(abs).join(project).split(`eval/fixtures/${c.fixture}`).join(project);
  }
  return c.prompt.replace(/eval\/fixtures\//g, path.join(pkgRoot, "eval/fixtures") + path.sep);
}

/** Auto-approve pending permission requests on the ISOLATED eval server. */
async function autoApprove(base) {
  try {
    const reqs = (await api(base, "get", "/api/permission/request")).data ?? [];
    for (const r of reqs) {
      await api(base, "post", `/api/session/${r.sessionID}/permission/${r.id}/reply`, {
        decision: "always",
      }).catch(() => {});
      console.log(`  auto-approved: ${r.action} ${(r.resources ?? [])[0] ?? ""}`);
    }
  } catch {
    /* non-fatal */
  }
}

/** Poll until the session looks finished: last assistant has tokens + stop finish, or an idle marker. */
async function waitForDone(base, sid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await autoApprove(base); // e.g. looker reading repo fixture paths (external_directory)
    let msgs = [];
    try {
      msgs = (await api(base, "get", `/api/session/${sid}/context`)).data ?? [];
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const last = msgs[msgs.length - 1];
    if (msgs.some((m) => m.type === "idle")) return;
    if (last?.type === "assistant" && last.tokens && (last.finish === undefined || last.finish === "stop" || last.finish === "length")) return;
    await new Promise((r) => setTimeout(r, 8000));
  }
}

async function executeSuite() {
  if (!(maxRuns > 0) || !(maxCost > 0)) {
    die("refusing paid execution: --execute requires explicit --max-runs N and --max-cost-usd X (budget gate, eval/rubric.md)");
  }
  const selected = suite === "confirm" ? cases : cases.filter((c) => PILOT_CASES.includes(c.id));
  const arms = armSel === "both" ? ["baseline", "lean"] : [armSel];
  const planned = selected.length * arms.length;
  if (planned > maxRuns) {
    die(`planned ${planned} top-level runs exceed --max-runs ${maxRuns}; raise the budget or narrow the suite`);
  }
  console.log(`paid preflight: ${planned} top-level trials, budget $${maxCost} / ${maxRuns} runs. Unknown per-run cost: estimate conservatively.`);
  console.log("continuing in 5s (ctrl-c to abort)…");
  await new Promise((r) => setTimeout(r, 5000));

  fs.mkdirSync(outDir, { recursive: true });
  const results = { suite, frozen: { cases: selected.map((c) => c.id), arms }, trials: [], budget: { maxRuns, maxCost }, spent: 0, status: "incomplete" };

  const project = fs.mkdtempSync(path.join(os.homedir(), ".native-v2-eval-"));
  run("git", ["init", "-q", project]).catch(() => {}); // project-root detection
  const port = 14200 + (process.pid % 300);
  const oc = path.join(project, ".opencode");
  const { PLATFORMS, parseRole } = await import(
    pathToFileURL(path.join(pkgRoot, "lib/platforms.mjs")).href
  );
  const buildProject = async (arm) => {
    fs.rmSync(oc, { recursive: true, force: true });
    fs.mkdirSync(path.join(oc, "agents"), { recursive: true });
    for (const r of ROSTER) {
      const src = arm === "baseline" ? path.join(pkgRoot, "eval/baselines", `${r}.md`) : path.join(pkgRoot, "agents", `${r}.md`);
      const body = fs.readFileSync(src, "utf8");
      const fmAndBody = arm === "baseline" ? leanFrontmatter(PLATFORMS, parseRole, r) + body : body;
      fs.writeFileSync(path.join(oc, "agents", `${r}.md`), fmAndBody);
    }
    fs.cpSync(path.join(pkgRoot, "skills", "ulw-plan"), path.join(oc, "skills", "ulw-plan"), { recursive: true });
    fs.writeFileSync(
      path.join(oc, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugins: [path.join(pkgRoot, "plugin")],
        agents: { builder: { model: builderModel } },
      }, null, 2),
    );
  };

  const server = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: project,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, OPENCODE_PASSWORD: SERVER_PASSWORD },
  });
  const base = `http://127.0.0.1:${port}`;
  process.on("exit", () => {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
    fs.rmSync(project, { recursive: true, force: true });
  });

  // Boot poll (location is async — see scripts/smoke.mjs).
  let booted = false;
  for (let i = 0; i < 30 && !booted; i++) {
    try { booted = (await api(base, "get", "/api/agent")).data?.length > 0; } catch { /* retry */ }
    if (!booted) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!booted) { results.status = "blocked"; writeResults(results); die("location never booted", 2); }

  outer: for (const arm of arms) {
    await buildProject(arm);
    await api(base, "post", "/api/location/reload").catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    for (const c of selected) {
      if (results.trials.length >= maxRuns || results.spent >= maxCost) { results.status = "budget-exhausted"; break outer; }
      if (c.fixture?.startsWith("mini-project")) resetFixture(project, c.fixture);
      if (c.fixture === "momus-valid-plan" || c.fixture === "momus-broken-plan") {
        fs.mkdirSync(path.join(project, ".omo/plans"), { recursive: true });
        const name = c.fixture === "momus-valid-plan" ? "eval-momus-valid.md" : "eval-momus-broken.md";
        fs.copyFileSync(path.join(pkgRoot, "eval/fixtures", `${c.fixture}.md`), path.join(project, `.omo/plans/${name}`));
      }
      const t0 = Date.now();
      const prompt = buildPrompt(c, project);
      const trial = { case: c.id, role: c.role, arm, expect: c.expect };
      try {
        const created = await api(base, "post", "/api/session", { title: `eval-${c.id}-${arm}` });
        const sid = created.data?.id ?? created.id;
        // Both agent AND model must be pinned per trial: switchAgent keeps the
        // creation-time session model, and sessions default to the user's
        // global model (rubric: identical models across both arms).
        await api(base, "post", `/api/session/${sid}/agent`, { agent: c.role });
        await api(base, "post", `/api/session/${sid}/model`, { model: parseModelRef(builderModel) });
        await api(base, "post", `/api/session/${sid}/prompt`, { text: prompt });
        await waitForDone(base, sid, 10 * 60_000);
        const ctx = await api(base, "get", `/api/session/${sid}/context`);
        trial.transcript = (ctx.data ?? []).map((m) => ({ type: m.type, text: textOf(m) })).filter((m) => m.text);
        Object.assign(trial, await collectTree(base, sid));
        trial.durationMs = Date.now() - t0;
        results.spent += trial.cost ?? 0;
      } catch (err) {
        trial.error = err.message;
        trial.complete = false;
        trial.durationMs = Date.now() - t0;
      }
      results.trials.push(trial);
      console.log(`${arm}/${c.id}: ${trial.error ? "ERROR " + trial.error : `${trial.tokens?.input ?? "?"}in/${trial.tokens?.output ?? "?"}out $${(trial.cost ?? 0).toFixed(4)}`}`);
    }
  }
  if (results.status === "incomplete" && results.trials.length === planned) results.status = "complete";
  writeResults(results);
  console.log(`\nresults: ${path.join(outDir, "results.json")} (${results.status})`);
}

function resetFixture(project, fixture) {
  const src = path.join(pkgRoot, "eval/fixtures", fixture);
  const dstFiles = path.join(src, "src");
  const dstTest = path.join(src, "test");
  fs.rmSync(path.join(project, "src"), { recursive: true, force: true });
  fs.rmSync(path.join(project, "test"), { recursive: true, force: true });
  fs.cpSync(dstFiles, path.join(project, "src"), { recursive: true });
  fs.cpSync(dstTest, path.join(project, "test"), { recursive: true });
  if (fixture === "mini-project-dirty") fs.copyFileSync(path.join(src, "NOTES.md"), path.join(project, "NOTES.md"));
}

function leanFrontmatter(PLATFORMS, parseRole, role) {
  const meta = parseRole(fs.readFileSync(path.join(pkgRoot, `roles/${role}.md`), "utf8"));
  return PLATFORMS.opencode.frontmatter(meta);
}

function textOf(m) {
  if (m.type === "assistant") return (m.content ?? []).map((c) => c.text ?? "").join("\n");
  if (m.type === "user") return typeof m.text === "string" ? m.text : "";
  return m.text ?? "";
}

function writeResults(results) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}

/* ---------- main ---------- */
const errs = validate();
if (errs.length) die(`validation failed:\n  ${errs.join("\n  ")}`);
if (execute) {
  await executeSuite();
} else {
  const baselineChars = {}, leanChars = {};
  for (const r of ROSTER) {
    baselineChars[r] = fs.statSync(path.join(pkgRoot, "eval/baselines", `${r}.md`)).size;
    leanChars[r] = fs.statSync(path.join(pkgRoot, "agents", `${r}.md`)).size;
  }
  console.log(`dry-run ok: ${cases.length} cases validated, baselines + fixtures present.`);
  console.log("\nstatic prompt size (bytes, baseline → lean):");
  for (const r of ROSTER) {
    const pct = Math.round((1 - leanChars[r] / baselineChars[r]) * 100);
    console.log(`  ${r.padEnd(17)} ${String(baselineChars[r]).padStart(6)} → ${String(leanChars[r]).padStart(6)}  (${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%)`);
  }
  console.log("\npaid run: node eval/run.mjs --execute --suite pilot --max-runs N --max-cost-usd X --out <dir>");
  process.exit(0);
}
