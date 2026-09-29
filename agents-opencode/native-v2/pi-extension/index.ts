/**
 * plan_graph for pi (@earendil-works/pi-coding-agent)
 *
 * Task-DAG planner: registers the `plan_graph` tool (define/update/ready/
 * render/inspect/record_result) backed by the shared DAG core, and guards the
 * `subagent` tool so a delegation only runs when it is bound to a ready graph
 * node via its binding token ([graph:<task>@r<rev>]).
 *
 * Install: copy this directory into ~/.pi/agent/extensions/plan-graph/
 * (auto-discovered as index.ts), then restart pi or run /reload.
 * The ./lib copies ship with the extension; re-copy after editing
 * ../../lib in the repo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GraphStore, runOp, token } from "./lib/graph-tool.mjs";

const SESSION = "pi-session";

const TaskNode = Type.Object({
	id: Type.String({ description: "Unique task id" }),
	title: Type.String({ description: "Short task title" }),
	agent: Type.String({ description: "Delegation target: explore | librarian | metis | momus | oracle | multimodal-looker | builder" }),
	depends_on: Type.Array(Type.String(), { description: "Task ids that must record results first" }),
	scope: Type.Optional(Type.String({ description: "What the task touches" })),
	write_paths: Type.Optional(Type.Array(Type.String(), { description: "Files/dirs this task may write; used for conflict checks" })),
	deliverable: Type.Optional(Type.String({ description: "What the parent receives" })),
	acceptance: Type.Optional(Type.String({ description: "How completion is judged" })),
});

const PlanGraphParams = Type.Object({
	op: Type.Union(
		[
			Type.Literal("define"),
			Type.Literal("update"),
			Type.Literal("ready"),
			Type.Literal("render"),
			Type.Literal("inspect"),
			Type.Literal("record_result"),
		],
		{
			description:
				"define: register/replace the task DAG. update: add/modify nodes (bumps revision). ready: nodes delegatable now. render: text DAG + mermaid. inspect: full state. record_result: record a parent-verified outcome for an in-flight node.",
		},
	),
	tasks: Type.Optional(Type.Array(TaskNode, { description: "Task nodes for define/update" })),
	task_id: Type.Optional(Type.String({ description: "record_result: the in-flight task id" })),
	status: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("failed")]), { description: "record_result outcome" }),
	evidence: Type.Optional(Type.String({ description: "record_result: what the parent verified and how (required for completed)" })),
	parent_agent: Type.Optional(Type.String({ description: "define: agent owning this graph (prometheus or the executing main)" })),
});

export default function planGraph(pi: ExtensionAPI) {
	pi.setLabel?.("Plan Graph");
	const store = new GraphStore();

	pi.registerTool({
		name: "plan_graph",
		label: "Plan Graph",
		description:
			"Task DAG planner: register the delegation graph before spawning subagents, then delegate only ready nodes. Embed each node's binding token ([graph:<task>@r<rev>]) in the delegation prompt.",
		parameters: PlanGraphParams,
		async execute(_toolCallId, params) {
			const result = runOp(store, SESSION, params.op, params, params.parent_agent);
			const text = JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text }],
			};
		},
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "subagent") return undefined;
		const input = (event.input ?? {}) as Record<string, unknown>;

		// Collect (agent, prompt) pairs across the subagent tool's modes.
		const pairs: Array<{ agent?: string; prompt?: string }> = [];
		if (typeof input.agent === "string" || typeof input.task === "string") {
			pairs.push({ agent: input.agent as string | undefined, prompt: input.task as string | undefined });
		}
		for (const key of ["tasks", "chain"]) {
			const list = input[key];
			if (Array.isArray(list)) {
				for (const item of list) {
					if (item && typeof item === "object") {
						const o = item as Record<string, unknown>;
						pairs.push({ agent: o.agent as string | undefined, prompt: (o.task as string | undefined) ?? (o.prompt as string | undefined) });
					}
				}
			}
		}
		if (pairs.length === 0) return undefined; // not a delegation shape we know

		for (const pair of pairs) {
			const verdict = store.checkDelegation(SESSION, { agent: pair.agent, prompt: pair.prompt ?? "" });
			if (!verdict.ok) {
				const hint = verdict.hint ? ` — ${verdict.hint}` : "";
				return { block: true, reason: `[plan_graph] delegation blocked: ${verdict.error}${hint}` };
			}
			store.markInFlight(SESSION, verdict.task.id);
		}
		return undefined;
	});
}

// Re-exported for smoke tests: same binding-token format as the OpenCode plugin.
export { token };
