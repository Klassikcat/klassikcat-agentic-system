import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import plugin from "../plugin/index.js";

const PKG = path.resolve(import.meta.dirname, "..");

function mockCtx() {
  const tools = new Map();
  const beforeHooks = [];
  return {
    tools,
    beforeHooks,
    session: {
      get: async ({ sessionID }) => mockCtx.sessions?.[sessionID] ?? null,
    },
    tool: {
      transform(fn) {
        const editor = {
          add: (t) => tools.set(t.name, t),
          namespace() {},
        };
        fn(editor);
        return { dispose: async () => tools.clear() };
      },
      hook(name, fn) {
        assert.equal(name, "execute.before");
        beforeHooks.push(fn);
        return { dispose: async () => beforeHooks.pop() };
      },
    },
  };
}
mockCtx.sessions = {};

async function opencodeTool() {
  const ctx = mockCtx();
  const cleanup = await plugin.setup(ctx);
  return { ctx, cleanup, tool: ctx.tools.get("plan_graph") };
}

async function callTool(tool, input) {
  return tool.execute(input, { sessionID: input.__sid });
}

test("opencode plugin: registers plan_graph and enforces delegation guard", async () => {
  const { ctx, cleanup, tool } = await opencodeTool();
  assert.ok(tool, "plan_graph tool registered");

  const sid = "ses_op1";
  mockCtx.sessions[sid] = { agent: "build", parentID: null };

  // delegation without a graph is blocked
  await assert.rejects(
    () => ctx.beforeHooks[0]({ tool: "subagent", sessionID: sid, input: { agent: "explore", prompt: "hi" } }),
    /no plan graph registered/,
  );

  // define a graph
  const def = await callTool(tool, {
    __sid: sid, op: "define", parent_agent: "build",
    tasks: [
      { id: "a", title: "Find auth flow", agent: "explore", depends_on: [] },
      { id: "c", title: "Implement", agent: "builder", depends_on: ["a"] },
    ],
  });
  const parsed = JSON.parse(def.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.revision, 1);

  // unbound delegation blocked; bound+ready passes and marks in-flight
  await assert.rejects(
    () => ctx.beforeHooks[0]({ tool: "subagent", sessionID: sid, input: { agent: "explore", prompt: "no token" } }),
    /missing task binding token/,
  );
  await ctx.beforeHooks[0]({
    tool: "subagent", sessionID: sid,
    input: { agent: "explore", prompt: "map auth [graph:a@r1]" },
  });
  // duplicate now blocked (in-flight)
  await assert.rejects(
    () => ctx.beforeHooks[0]({
      tool: "subagent", sessionID: sid,
      input: { agent: "explore", prompt: "again [graph:a@r1]" },
    }),
    /already in_flight/,
  );

  // record completion → builder node becomes delegatable
  const done = await callTool(tool, { __sid: sid, op: "record_result", task_id: "a", status: "completed", evidence: "verified files" });
  assert.equal(JSON.parse(done.content).ok, true);
  await ctx.beforeHooks[0]({
    tool: "subagent", sessionID: sid,
    input: { agent: "builder", prompt: "implement [graph:c@r1]" },
  });

  await cleanup();
});

test("opencode plugin: prometheus session cannot spawn builder", async () => {
  const { ctx, cleanup, tool } = await opencodeTool();
  const sid = "ses_prom1";
  mockCtx.sessions[sid] = { agent: "prometheus", parentID: null };
  await callTool(tool, {
    __sid: sid, op: "define", parent_agent: "prometheus",
    tasks: [{ id: "impl", title: "Implement", agent: "builder", depends_on: [] }],
  });
  await assert.rejects(
    () => ctx.beforeHooks[0]({
      tool: "subagent", sessionID: sid,
      input: { agent: "builder", prompt: "x [graph:impl@r1]" },
    }),
    /never spawns builder/,
  );
  await cleanup();
});

test("opencode plugin: child sessions cannot delegate; task tool also guarded", async () => {
  const { ctx, cleanup, tool } = await opencodeTool();
  const sid = "ses_child1";
  mockCtx.sessions[sid] = { agent: "builder", parentID: "ses_parent" };
  await callTool(tool, {
    __sid: "ses_parent", op: "define", parent_agent: "build",
    tasks: [{ id: "a", title: "T", agent: "explore", depends_on: [] }],
  });
  await assert.rejects(
    () => ctx.beforeHooks[0]({
      tool: "task", sessionID: sid,
      input: { agent: "explore", prompt: "x [graph:a@r1]" },
    }),
    /subagent sessions cannot delegate/,
  );
  await cleanup();
});

test("pi extension matches the current pi extension shape", async () => {
  const ts = fs.readFileSync(path.join(PKG, "pi-extension/index.ts"), "utf8");
  // Current pi (@earendil-works/pi-coding-agent): typed ExtensionAPI + typebox
  assert.match(ts, /@earendil-works\/pi-coding-agent/);
  assert.match(ts, /from "typebox"/);
  assert.match(ts, /pi\.registerTool\(/);
  assert.match(ts, /name: "plan_graph"/);
  // Guard: subagent tool, single + tasks/chain modes, pi-style block result.
  assert.match(ts, /pi\.on\("tool_call"/);
  assert.match(ts, /"subagent"/);
  assert.match(ts, /\["tasks", "chain"\]/);
  assert.match(ts, /block: true/);
  // Self-contained: ships its own copy of the DAG core.
  for (const f of ["graph-tool.mjs", "dag.mjs"]) {
    const copy = fs.readFileSync(path.join(PKG, "pi-extension/lib", f), "utf8");
    const core = fs.readFileSync(path.join(PKG, "lib", f), "utf8");
    assert.equal(copy, core, `pi-extension/lib/${f} drifted from lib/${f}; re-copy`);
  }
});
