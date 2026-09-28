import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { aggregate, median } from "../eval/report.mjs";

const run = promisify(execFile);
const pkgRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");

test("cases.json: 18 cases, unique ids, full roster coverage", () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(pkgRoot, "eval/cases.json"), "utf8"));
  assert.equal(cases.length, 18);
  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, 18);
  const builder = cases.filter((c) => c.role === "builder");
  assert.equal(builder.length, 4); // simple, negative, multifile, dirty
  assert.equal(cases.filter((c) => c.role === "prometheus").length, 2);
  for (const c of cases) assert.ok(c.expect, `${c.id} needs expect`);
});

test("run.mjs --dry-run validates and prints the size preview", async () => {
  const { stdout } = await run(process.execPath, [path.join(pkgRoot, "eval/run.mjs"), "--dry-run"]);
  assert.match(stdout, /dry-run ok: 18 cases validated/);
  assert.match(stdout, /builder\s+\d+\s+→\s+\d+\s+\(-\d+%\)/);
});

test("run.mjs --execute refuses to run without both budget params", async () => {
  await assert.rejects(
    run(process.execPath, [path.join(pkgRoot, "eval/run.mjs"), "--execute"]),
    (err) => {
      assert.match(err.stderr || err.message, /requires explicit --max-runs N and --max-cost-usd X/);
      return true;
    },
  );
});

test("median handles empty, odd, and even inputs", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([1, NaN, 3]), 2);
});

test("aggregate: sums per arm, ratios on complete trials only, nulls preserved", () => {
  const results = {
    status: "complete",
    budget: { maxRuns: 4, maxCost: 2 },
    trials: [
      { role: "explore", arm: "lean", complete: true, tokens: { input: 100, output: 20, cache_read: 0 }, toolCalls: 2, cost: 0.01 },
      { role: "explore", arm: "baseline", complete: true, tokens: { input: 300, output: 60, cache_read: 0 }, toolCalls: 5, cost: 0.02 },
      { role: "explore", arm: "baseline", complete: false, error: "wait timeout", tokens: null, toolCalls: 0 },
      { role: "builder", arm: "lean", complete: true, tokens: { input: 500, output: 100, cache_read: 50 }, toolCalls: 9, cost: 0.05 },
    ],
  };
  const agg = aggregate(results);
  const ex = agg.roles.find((r) => r.role === "explore");
  assert.equal(ex.lean_tokens, 120);
  assert.equal(ex.baseline_tokens, 360); // incomplete baseline trial excluded
  assert.equal(ex.token_ratio, (120 / 360).toFixed(2) * 1);
  assert.equal(ex.baseline_incomplete, 1);
  const b = agg.roles.find((r) => r.role === "builder");
  assert.equal(b.baseline_tokens, null); // no complete baseline trials → null, not 0
  assert.equal(b.token_ratio, undefined);
  assert.equal(agg.incomplete, 1);
  assert.equal(agg.spent_usd, 0.08);
  assert.match(agg.savings_note, /failures block acceptance/);
});

test("report CLI renders a markdown table from a results file", async () => {
  const tmp = fs.mkdtempSync("/tmp/native-v2-evaltest-");
  const file = path.join(tmp, "results.json");
  fs.writeFileSync(file, JSON.stringify({
    status: "pilot",
    budget: { maxRuns: 2, maxCost: 1 },
    trials: [
      { role: "builder", arm: "lean", complete: true, tokens: { input: 10, output: 5 }, toolCalls: 1, cost: 0.001 },
      { role: "builder", arm: "baseline", complete: true, tokens: { input: 40, output: 10 }, toolCalls: 3, cost: 0.002 },
    ],
  }));
  const { stdout } = await run(process.execPath, [path.join(pkgRoot, "eval/report.mjs"), file]);
  assert.match(stdout, /# native-v2 eval report — pilot/);
  assert.match(stdout, /\| builder \| 15 \| 50 \| 0\.3 /);
  fs.rmSync(tmp, { recursive: true, force: true });
});
