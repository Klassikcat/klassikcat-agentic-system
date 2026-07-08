import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";

test("claude provider builds planning invocation", () => {
  const provider = new ClaudeProvider({ command: "claude-test" });
  assert.equal(provider.role, "planning");
  assert.deepEqual(provider.buildInvocation({ prompt: "make a plan" }), {
    command: "claude-test",
    args: ["-p", "make a plan", "--output-format", "json", "--max-turns", "0"],
  });
});

test("codex provider enforces read-only review sandbox", () => {
  const provider = new CodexProvider({ command: "codex-test" });
  const invocation = provider.buildInvocation({ prompt: "review diff" });
  assert.equal(provider.role, "review");
  assert.equal(invocation.command, "codex-test");
  assert.deepEqual(invocation.args, ["exec", "review diff", "--json", "--sandbox", "read-only"]);
});

test("opencode provider builds orchestration invocation", () => {
  const provider = new OpenCodeProvider({ command: "opencode-test" });
  assert.equal(provider.role, "orchestration");
  assert.deepEqual(provider.buildInvocation({ prompt: "coordinate" }), {
    command: "opencode-test",
    args: ["run", "--print", "coordinate"],
  });
});

test("claude provider uses OMO_CLAUDE_MAX_TURNS env when set", () => {
  const previous = process.env.OMO_CLAUDE_MAX_TURNS;
  process.env.OMO_CLAUDE_MAX_TURNS = "5";
  try {
    const provider = new ClaudeProvider({ command: "claude-test" });
    const inv = provider.buildInvocation({ prompt: "test" });
    assert.deepEqual(inv.args, ["-p", "test", "--output-format", "json", "--max-turns", "5"]);
  } finally {
    if (previous === undefined) delete process.env.OMO_CLAUDE_MAX_TURNS;
    else process.env.OMO_CLAUDE_MAX_TURNS = previous;
  }
});

test("claude provider defaults to --max-turns 0 when OMO_CLAUDE_MAX_TURNS not set", () => {
  const previous = process.env.OMO_CLAUDE_MAX_TURNS;
  delete process.env.OMO_CLAUDE_MAX_TURNS;
  try {
    const provider = new ClaudeProvider({ command: "claude-test" });
    const inv = provider.buildInvocation({ prompt: "test" });
    assert.deepEqual(inv.args, ["-p", "test", "--output-format", "json", "--max-turns", "0"]);
  } finally {
    if (previous !== undefined) process.env.OMO_CLAUDE_MAX_TURNS = previous;
  }
});
