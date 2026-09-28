import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../plugin/index.js";
import piExtension from "../pi-extension/plan-graph.js";

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

test("pi extension: registers tool and blocks unbound delegation", async () => {
  const registered = [];
  const handlers = {};
  const pi = {
    setLabel() {},
    zod: {
      // Minimal zod stand-in supporting the builder chaining pi's real zod uses.
      object: (shape) => ({ shape, __zod: true }),
      array: (item) => ({ item, __zod: true, optional() { return this; } }),
      enum: (vals) => ({ vals, __zod: true, optional() { return this; } }),
      string: () => ({ __zod: true, optional() { return this; } }),
    },
    registerTool(def) {
      registered.push(def);
    },
    on(name, fn) {
      handlers[name] = fn;
    },
  };
  piExtension(pi);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "plan_graph");
  const tool = registered[0];

  // tool works end-to-end through the shared core
  const def = await tool.execute("call1", {
    op: "define", parent_agent: "build",
    tasks: [{ id: "a", title: "T", agent: "explore", depends_on: [] }],
  });
  assert.equal(def.isError, false);
  assert.ok(JSON.parse(def.content[0].text).ok);

  // guarded spawn without token is refused via yield
  let yielded = null;
  await handlers.tool_call(
    { toolName: "subagent", arguments: { agent: "explore", prompt: "no token" }, yield: (m) => (yielded = m) },
    {},
  );
  assert.match(yielded, /missing task binding token/);

  // bound delegation marks in-flight; duplicate refused
  yielded = null;
  await handlers.tool_call(
    { toolName: "subagent", arguments: { agent: "explore", prompt: "x [graph:a@r1]" }, yield: (m) => (yielded = m) },
    {},
  );
  assert.equal(yielded, null);
  await handlers.tool_call(
    { toolName: "subagent", arguments: { agent: "explore", prompt: "again [graph:a@r1]" }, yield: (m) => (yielded = m) },
    {},
  );
  assert.match(yielded, /already in_flight/);

  // non-delegation tools pass through untouched
  let pass = true;
  await handlers.tool_call({ toolName: "read", arguments: { path: "x" }, yield: () => (pass = false) }, {});
  assert.equal(pass, true);
});
