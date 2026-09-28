#!/usr/bin/env node
/**
 * Aggregate an eval results.json into a per-role + total lean-vs-baseline
 * report. Quality asserts are listed per trial; failures are NEVER averaged
 * away (rubric.md). Missing usage shows as null, incomplete trials counted
 * separately and excluded from savings math.
 *
 *   node eval/report.mjs <path/to/results.json>
 */
import fs from "node:fs";
import path from "node:path";

export function median(xs) {
  const v = xs.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function aggregate(results) {
  const ok = (t) => t && t.complete !== false && !t.error;
  const byRole = {};
  for (const t of results.trials ?? []) {
    byRole[t.role] ??= { lean: [], baseline: [] };
    byRole[t.role][t.arm].push(t);
  }
  const rows = [];
  for (const [role, arms] of Object.entries(byRole)) {
    const sumTokens = (arr) => arr.filter(ok).reduce((a, t) => a + (t.tokens?.input ?? 0) + (t.tokens?.output ?? 0) + (t.tokens?.cache_read ?? 0), 0);
    const row = {
      role,
      lean_trials: arms.lean.length,
      baseline_trials: arms.baseline.length,
      lean_tokens: sumTokens(arms.lean) || null,
      baseline_tokens: sumTokens(arms.baseline) || null,
      lean_incomplete: arms.lean.filter((t) => !ok(t)).length,
      baseline_incomplete: arms.baseline.filter((t) => !ok(t)).length,
      tool_calls_lean: arms.lean.filter(ok).reduce((a, t) => a + (t.toolCalls ?? 0), 0) || null,
      tool_calls_baseline: arms.baseline.filter(ok).reduce((a, t) => a + (t.toolCalls ?? 0), 0) || null,
    };
    if (row.lean_tokens != null && row.baseline_tokens) {
      row.token_ratio = Number((row.lean_tokens / row.baseline_tokens).toFixed(2));
    }
    rows.push(row);
  }
  const spent = (results.trials ?? []).reduce((a, t) => a + (t.cost ?? 0), 0);
  return {
    status: results.status ?? "unknown",
    budget: results.budget ?? null,
    spent_usd: Number(spent.toFixed(4)),
    total_trials: (results.trials ?? []).length,
    incomplete: (results.trials ?? []).filter((t) => !ok(t)).length,
    roles: rows,
    savings_note: "ratios cover complete trials only; required-case failures block acceptance regardless of savings (rubric.md)",
  };
}

function renderMarkdown(agg) {
  const lines = [];
  lines.push(`# native-v2 eval report — ${agg.status}`);
  lines.push(`\ntrials: ${agg.total_trials} (incomplete/error: ${agg.incomplete}) · spent: $${agg.spent_usd}${agg.budget ? ` of $${agg.budget.maxCost}` : ""}`);
  lines.push("\n| role | lean tok (med) | baseline tok (med) | ratio | lean/base calls | incomplete L/B |\n|---|---|---|---|---|---|");
  for (const r of agg.roles) {
    lines.push(`| ${r.role} | ${r.lean_tokens ?? "null"} | ${r.baseline_tokens ?? "null"} | ${r.token_ratio ?? "—"} | ${r.tool_calls_lean ?? "—"}/${r.tool_calls_baseline ?? "—"} | ${r.lean_incomplete}/${r.baseline_incomplete} |`);
  }
  lines.push(`\n> ${agg.savings_note}`);
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node eval/report.mjs <results.json>");
    process.exit(1);
  }
  const agg = aggregate(JSON.parse(fs.readFileSync(file, "utf8")));
  console.log(renderMarkdown(agg));
}
