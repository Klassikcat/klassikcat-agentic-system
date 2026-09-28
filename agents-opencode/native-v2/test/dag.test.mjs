import test from "node:test";
import assert from "node:assert/strict";
import {
  validateGraph,
  topoBatches,
  computeReady,
  applyStatus,
  renderMermaid,
  renderTextDag,
} from "../lib/dag.mjs";

const task = (id, depends_on = [], extra = {}) => ({
  id,
  title: `T ${id}`,
  agent: "explore",
  depends_on,
  status: "pending",
  ...extra,
});

test("accepts a valid DAG and rejects cycles/self/dupes/unknown", () => {
  const ok = validateGraph([task("a"), task("b", ["a"]), task("c", ["a", "b"])]);
  assert.equal(ok.ok, true);

  const cycle = validateGraph([task("a", ["b"]), task("b", ["a"])]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.errors.join(";"), /cycle/i);

  const self = validateGraph([task("a", ["a"])]);
  assert.equal(self.ok, false);
  assert.match(self.errors.join(";"), /self/i);

  const dup = validateGraph([task("a"), task("a")]);
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(";"), /duplicate/i);

  const unknown = validateGraph([task("a", ["zzz"])]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(";"), /unknown dependency zzz/i);

  const empty = validateGraph([]);
  assert.equal(empty.ok, false);
});

test("topoBatches groups independent nodes together and respects deps", () => {
  const batches = topoBatches([
    task("a"),
    task("b"),
    task("c", ["a", "b"]),
    task("d", ["c"]),
  ]);
  assert.deepEqual(batches, [["a", "b"], ["c"], ["d"]]);
});

test("ready: only deps-completed nodes without conflicts become ready", () => {
  const tasks = [
    task("a"),
    task("b", ["a"]),
    task("c", [], { write_paths: ["src/x.ts"] }),
    task("d", [], { write_paths: ["src/x.ts"] }),
  ];
  let r = computeReady(tasks);
  assert.deepEqual(r.ready.map((t) => t.id).sort(), ["a", "c", "d"]);

  // c in flight → d blocked by write-path conflict, b by dependency.
  r = computeReady(tasks, new Set(["c"]));
  const ids = r.ready.map((t) => t.id);
  assert.ok(!ids.includes("d"));
  assert.ok(!ids.includes("b"));
  const dReasons = r.notReady.find((n) => n.id === "d").reasons.join(";");
  assert.match(dReasons, /conflicts with in-flight c/);
  assert.match(dReasons, /src\/x\.ts/);
});

test("ready: failed or skipped ancestors block descendants", () => {
  const tasks = [
    { ...task("a"), status: "failed" },
    task("b", ["a"]),
    { ...task("c"), status: "skipped" },
    task("d", ["c"]),
  ];
  const r = computeReady(tasks);
  assert.equal(r.ready.length, 0);
  assert.ok(r.blockedByFailure.has("b"));
  assert.ok(r.blockedByFailure.has("d"));
});

test("directory write paths conflict with files beneath them", () => {
  const tasks = [
    task("a", [], { write_paths: ["src/api/"] }),
    task("b", [], { write_paths: ["src/api/router.ts"] }),
  ];
  const r = computeReady(tasks, new Set(["a"]));
  const reasons = r.notReady.find((n) => n.id === "b").reasons.join(";");
  assert.match(reasons, /conflicts with in-flight a/);
});

test("status transitions follow the lifecycle", () => {
  const tasks = [task("a")];
  assert.equal(applyStatus(tasks, "a", "completed").ok, false); // pending → completed illegal
  assert.equal(applyStatus(tasks, "a", "in_flight").ok, true);
  assert.equal(applyStatus(tasks, "a", "in_flight").ok, false); // double-flight illegal
  assert.equal(applyStatus(tasks, "a", "completed").ok, true);
  assert.equal(applyStatus(tasks, "a", "failed").ok, false); // terminal
  assert.equal(applyStatus(tasks, "zzz", "failed").ok, false);
});

test("mermaid render keeps dep→node direction for every edge", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["a", "b"])];
  const md = renderMermaid(tasks);
  assert.match(md, /^flowchart TD/);
  assert.match(md, /a --> b/);
  assert.match(md, /a --> c/);
  assert.match(md, /b --> c/);
});

test("text render shows fan-in labels and status marks", () => {
  const tasks = [
    task("a"),
    task("b"),
    task("c", ["a", "b"], { status: "completed" }),
  ];
  const txt = renderTextDag(tasks);
  assert.match(txt, /c ← a\+b/);
  assert.match(txt, /\{done\}/);
  assert.match(txt, /\{pending\}/);
});
