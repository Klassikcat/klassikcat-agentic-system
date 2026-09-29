/**
 * plan_graph for pi (@earendil-works/pi-coding-agent)
 *
 * Task-DAG planner: registers the `plan_graph` tool (define/update/ready/
 * render/inspect/record_result) backed by the shared DAG core, and guards
 * the `subagent` tool so a delegation only runs when it is bound to a ready
 * graph node via its binding token ([graph:<task>@r<rev>]).
 *
 * Zero runtime imports beyond the bundled ./lib — same self-contained
 * pattern as trufflehog-guard. TypeBox parameters are plain JSON Schema
 * objects (TypeBox compiles to the same shape), so no typebox dependency.
 *
 * Install: copy this directory into ~/.pi/agent/extensions/plan-graph/
 * (auto-discovered as index.ts), then restart pi or run /reload.
 */

import { GraphStore, runOp } from "./lib/graph-tool.mjs";

const SESSION = "pi-session";

// JSON Schema (TypeBox-compatible) for the plan_graph parameters.
const PLAN_GRAPH_PARAMS = {
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
			description: "Task nodes for define/update",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Unique task id" },
					title: { type: "string", description: "Short task title" },
					agent: { type: "string", description: "Delegation target: explore | librarian | metis | momus | oracle | multimodal-looker | builder" },
					depends_on: { type: "array", items: { type: "string" }, description: "Task ids that must record results first" },
					scope: { type: "string", description: "What the task touches" },
					write_paths: { type: "array", items: { type: "string" }, description: "Files/dirs this task may write; used for conflict checks" },
					deliverable: { type: "string", description: "What the parent receives" },
					acceptance: { type: "string", description: "How completion is judged" },
				},
				required: ["id", "title", "agent", "depends_on"],
			},
		},
		task_id: { type: "string", description: "record_result: the in-flight task id" },
		status: { type: "string", enum: ["completed", "failed"], description: "record_result outcome" },
		evidence: { type: "string", description: "record_result: what the parent verified and how (required for completed)" },
		parent_agent: { type: "string", description: "define: agent owning this graph (prometheus or the executing main)" },
	},
	required: ["op"],
};

export default function planGraph(pi) {
	const store = new GraphStore();

	pi.registerTool({
		name: "plan_graph",
		label: "Plan Graph",
		description:
			"Task DAG planner: register the delegation graph before spawning subagents, then delegate only ready nodes. Embed each node's binding token ([graph:<task>@r<rev>]) in the delegation prompt.",
		parameters: PLAN_GRAPH_PARAMS,
		async execute(_toolCallId, params) {
			const result = runOp(store, SESSION, params.op, params, params.parent_agent);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
