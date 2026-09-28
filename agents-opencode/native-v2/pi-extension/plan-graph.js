/**
 * pi (oh-my-pi) extension: `plan_graph` tool + delegation guard.
 *
 * Mirrors the OpenCode plugin on pi's extension API (validated against
 * OMP v16.0.4 like the other hooks in this repo):
 *   - pi.registerTool / pi.zod  → the plan_graph tool
 *   - pi.on("tool_call")       → guard for subagent-spawn style tools,
 *                                 with a blocking yield message on violation
 *
 * pi runs one interactive session per process, so the store keys a single
 * active graph per process rather than per session id.
 */
import { GraphStore, runOp } from "../lib/graph-tool.mjs";

const DELEGATION_TOOL_NAMES = new Set(["subagent", "task", "spawn_agent"]);

export default function planGraph(pi) {
  pi.setLabel?.("Plan Graph");
  const z = pi.zod;
  const store = new GraphStore();
  const SESSION = "pi-session";

  pi.registerTool({
    name: "plan_graph",
    label: "Plan Graph",
    description:
      "Task DAG planner: register the delegation graph before spawning subagents, then delegate only ready nodes. Embed each node's binding token ([graph:<task>@r<rev>]) in the delegation prompt.",
    parameters: z.object({
      op: z.enum(["define", "update", "ready", "render", "inspect", "record_result"]),
      tasks: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            agent: z.string(),
            depends_on: z.array(z.string()),
            scope: z.string().optional(),
            write_paths: z.array(z.string()).optional(),
            deliverable: z.string().optional(),
            acceptance: z.string().optional(),
          }),
        )
        .optional(),
      task_id: z.string().optional(),
      status: z.enum(["completed", "failed"]).optional(),
      evidence: z.string().optional(),
      parent_agent: z.string().optional(),
    }),
    async execute(_id, params) {
      const result = runOp(store, SESSION, params.op, params, params.parent_agent);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.ok === false,
      };
    },
  });

  pi.on("tool_call", async (event, _ctx) => {
    const toolName = event?.toolName;
    if (!DELEGATION_TOOL_NAMES.has(toolName)) return;

    const args = event?.arguments ?? event?.args ?? {};
    const agent = args.agent ?? args.subagent_type;
    const prompt = args.prompt ?? "";
    const verdict = store.checkDelegation(SESSION, { agent, prompt });
    if (verdict.ok) {
      store.markInFlight(SESSION, verdict.task.id);
      return;
    }
    // Blocking refusal: pi surfaces the yielded message to the model.
    if (typeof event?.yield === "function") {
      event.yield(
        `[plan_graph] delegation blocked: ${verdict.error}${verdict.hint ? ` — ${verdict.hint}` : ""}`,
      );
      return;
    }
    throw new Error(`[plan_graph] delegation blocked: ${verdict.error}`);
  });
}
