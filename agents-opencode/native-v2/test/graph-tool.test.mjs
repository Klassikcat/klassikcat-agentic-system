import test from "node:test";
import assert from "node:assert/strict";
import { GraphStore, token } from "../lib/graph-tool.mjs";

const T = (id, agent, depends_on = [], extra = {}) => ({
  id, title: `T ${id}`, agent, depends_on, status: "pending", ...extra,
});

function seeded() {
  const store = new GraphStore();
  store.define("s1", [T("a", "explore"), T("b", "librarian"), T("c", "builder", ["a", "b"])], "build");
  return store;
}

test("define → ready → delegate → record cycle unlocks dependents", () => {
  const store = seeded();
  let r = store.ready("s1");
  assert.deepEqual(r.ready.map((t) => t.id).sort(), ["a", "b"]);

  const g = store.checkDelegation("s1", { agent: "explore", prompt: `do it ${token("a", 1)}` });
  assert.equal(g.ok, true);
  assert.equal(store.markInFlight("s1", "a").ok, true);

  // duplicate delegation of an in-flight node is rejected
  const dup = store.checkDelegation("s1", { agent: "explore", prompt: `again ${token("a", 1)}` });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already in_flight/);

  assert.equal(store.recordResult("s1", "a", "completed", "grep verified; 3 files").ok, true);
  r = store.ready("s1");
  assert.deepEqual(r.ready.map((t) => t.id), ["b"]); // c still waits on b

  store.checkDelegation("s1", { agent: "librarian", prompt: `x ${token("b", 1)}` });
  store.markInFlight("s1", "b");
  store.recordResult("s1", "b", "completed", "docs cited");
  r = store.ready("s1");
  assert.deepEqual(r.ready.map((t) => t.id), ["c"]);
});

test("record_result requires evidence for completed and rejects illegal states", () => {
  const store = seeded();
  assert.equal(store.recordResult("s1", "a", "completed", "ev").ok, false); // pending, not in-flight
  assert.equal(store.recordResult("s1", "zz", "failed").ok, false);
  store.markInFlight("s1", "a");
  assert.equal(store.recordResult("s1", "a", "completed", "").ok, false); // no evidence
  assert.equal(store.recordResult("s1", "a", "weird").ok, false);
  assert.equal(store.recordResult("s1", "a", "failed", null).ok, true);
});

test("guard rejects missing graph, missing token, stale revision, unknown task", () => {
  const store = new GraphStore();
  let g = store.checkDelegation("s1", { agent: "explore", prompt: "hi" });
  assert.equal(g.ok, false);
  assert.match(g.error, /no plan graph/);

  store.define("s1", [T("a", "explore")], "build");
  g = store.checkDelegation("s1", { agent: "explore", prompt: "no token" });
  assert.equal(g.ok, false);
  assert.match(g.error, /missing task binding token/);

  g = store.checkDelegation("s1", { agent: "explore", prompt: `x ${token("a", 99)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /stale binding r99/);

  g = store.checkDelegation("s1", { agent: "explore", prompt: `x ${token("ghost", 1)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /unknown task ghost/);
});

test("guard enforces assigned agent and not-ready dependencies", () => {
  const store = seeded();
  let g = store.checkDelegation("s1", { agent: "oracle", prompt: `x ${token("a", 1)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /assigned to explore, not oracle/);

  g = store.checkDelegation("s1", { agent: "builder", prompt: `x ${token("c", 1)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /not ready/);
  assert.match(g.error, /dependency a is pending/);
});

test("guard blocks prometheus→builder and child-session delegation", () => {
  const store = new GraphStore();
  store.define("p1", [T("impl", "builder")], "prometheus");
  const g = store.checkDelegation("p1", { agent: "builder", prompt: `x ${token("impl", 1)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /never spawns builder/);

  // read-only role from prometheus is fine
  store.define("p2", [T("look", "explore")], "prometheus");
  assert.equal(store.checkDelegation("p2", { agent: "explore", prompt: `x ${token("look", 1)}` }).ok, true);

  const child = store.checkDelegation("p1", { agent: "explore", prompt: "x", isChildSession: true });
  assert.equal(child.ok, false);
  assert.match(child.error, /subagent sessions cannot delegate/);
});

test("guard blocks write-path conflicts with in-flight tasks", () => {
  const store = new GraphStore();
  store.define(
    "s1",
    [
      T("x", "builder", [], { write_paths: ["src/api/"] }),
      T("y", "builder", [], { write_paths: ["src/api/router.ts"] }),
    ],
    "build",
  );
  store.markInFlight("s1", "x");
  const g = store.checkDelegation("s1", { agent: "builder", prompt: `x ${token("y", 1)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /not ready/);
  assert.match(g.error, /conflicts with in-flight x/);
});

test("update bumps revision, preserves terminal nodes, invalidates old tokens", () => {
  const store = seeded();
  store.markInFlight("s1", "a");
  store.recordResult("s1", "a", "completed", "ev1");

  const tasks = [
    T("a", "explore"),
    T("b", "librarian"),
    T("c", "builder", ["a", "b"]),
    T("d", "builder", ["c"]),
  ];
  const r = store.update("s1", tasks);
  assert.equal(r.ok, true);
  assert.equal(r.revision, 2);
  const insp = store.inspect("s1");
  assert.equal(insp.tasks.find((t) => t.id === "a").status, "completed");
  assert.equal(insp.tasks.find((t) => t.id === "d").status, "pending");

  // old-revision token now stale
  const g = store.checkDelegation("s1", { agent: "librarian", prompt: `x ${token("b", 1)}` });
  assert.equal(g.ok, false);
  assert.match(g.error, /stale binding r1/);
  assert.equal(store.checkDelegation("s1", { agent: "librarian", prompt: `x ${token("b", 2)}` }).ok, true);
});

test("failed task blocks descendants; rework appends a new node", () => {
  const store = seeded();
  store.markInFlight("s1", "a");
  store.recordResult("s1", "a", "failed", "timeout");
  let r = store.ready("s1");
  // b is independent of a, so it stays ready; only c is blocked by failure
  assert.deepEqual(r.ready.map((t) => t.id), ["b"]);
  assert.ok(r.blockedByFailure.includes("c"));

  // rework: retry a as a new node
  store.update("s1", [
    T("a", "explore"),
    T("a2", "explore", []),
    T("b", "librarian"),
    T("c", "builder", ["a2", "b"]),
  ]);
  r = store.ready("s1");
  assert.deepEqual(r.ready.map((t) => t.id).sort(), ["a2", "b"]);
});

test("render returns text DAG, mermaid, batches, and ready set", () => {
  const store = seeded();
  const r = store.render("s1");
  assert.match(r.textDag, /c ← a\+b/);
  assert.match(r.mermaid, /a --> c/);
  assert.deepEqual(r.batches, [["a", "b"], ["c"]]);
  assert.equal(r.ready.length, 2);
});
