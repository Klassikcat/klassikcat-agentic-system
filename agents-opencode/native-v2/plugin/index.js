/**
 * OpenCode V2 plugin: `plan_graph` tool + delegation guard.
 *
 * Registers one tool (define/update/ready/render/inspect/record_result) backed
 * by the shared DAG core, and intercepts subagent delegation via
 * tool.execute.before so a session can only spawn children bound to a
 * ready graph node (CONTRACT.md "Delegation contract").
 *
 * Agents/skills come from this bundle's generated definitions; the plugin is
 * loaded separately (see ../opencode.example.jsonc).
 */
import { GraphStore, runOp } from "../lib/graph-tool.mjs";

const DELEGATION_TOOLS = new Set(["subagent", "task"]);

const TOOL_INPUT = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["define", "update", "ready", "render", "inspect", "record_result"],
      description:
        "define: register/replace the task DAG. update: add/modify nodes (bumps revision). ready: nodes delegatable now. render: text DAG + mermaid. inspect: full state. record_result: record a parent-verified outcome for an in-flight node.",
    },
    tasks: {
      type: "array",
      description: "Task nodes for define/update: { id, title, agent, depends_on[], scope?, write_paths[], deliverable?, acceptance? }",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          agent: { type: "string", description: "one of: explore, librarian, metis, momus, oracle, multimodal-looker, builder" },
          depends_on: { type: "array", items: { type: "string" } },
          scope: { type: "string" },
          write_paths: { type: "array", items: { type: "string" } },
          deliverable: { type: "string" },
          acceptance: { type: "string" },
        },
        required: ["id", "title", "agent", "depends_on"],
      },
    },
    task_id: { type: "string", description: "record_result: the in-flight task id" },
    status: { type: "string", enum: ["completed", "failed"], description: "record_result outcome" },
    evidence: { type: "string", description: "record_result: what the parent verified and how (required for completed)" },
    parent_agent: { type: "string", description: "define: agent owning this graph (prometheus or the executing primary)" },
  },
  required: ["op"],
};

export default {
  id: "native-v2-plan-graph",
  setup(ctx) {
    const store = new GraphStore();

    async function agentOfSession(sessionID) {
      // Best-effort: session agent name for child-session detection and
      // prometheus/builder policy. Failures fall back to permissive null.
      try {
        const info = await ctx.session.get({ sessionID });
        return { agent: info?.agent, parentID: info?.parentID };
      } catch {
        return { agent: null, parentID: null };
      }
    }

    const registration = ctx.tool.transform((editor) => {
      editor.add({
        name: "plan_graph",
        description:
          "Task DAG planner: register the delegation graph before spawning subagents, then delegate only ready nodes. Embed each node's binding token ([graph:<task>@r<rev>]) in the delegation prompt; the guard rejects unbound or not-ready delegation.",
        input: TOOL_INPUT,
        execute: async (input, context) => {
          const sessionID = context?.sessionID ?? input.session_id ?? null;
          if (!sessionID) {
            return {
              content:
                "plan_graph: no session context; pass session_id explicitly if running outside a session.",
              isError: true,
            };
          }
          const result = runOp(store, sessionID, input.op, input, input.parent_agent);
          return { content: JSON.stringify(result, null, 2), isError: result.ok === false };
        },
      });
    });

    // Delegation guard: binding token + readiness enforcement.
    const guard = ctx.tool.hook("execute.before", async (event, output) => {
      const tool = event?.tool;
      if (!DELEGATION_TOOLS.has(tool)) return;
      const input = event?.input ?? output?.args ?? {};
      const sessionID = event?.sessionID ?? input?.session_id;
      if (!sessionID) return; // nothing to bind against

      const { parentID } = await agentOfSession(sessionID);
      const verdict = store.checkDelegation(sessionID, {
        agent: input.agent,
        prompt: input.prompt,
        isChildSession: Boolean(parentID),
      });
      if (!verdict.ok) {
        throw new Error(
          `[plan_graph] delegation blocked: ${verdict.error}${verdict.hint ? ` — ${verdict.hint}` : ""}`,
        );
      }
      store.markInFlight(sessionID, verdict.task.id);
    });

    return async () => {
      await guard?.dispose?.();
      await registration?.dispose?.();
    };
  },
};
