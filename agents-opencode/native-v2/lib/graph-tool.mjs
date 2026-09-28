/**
 * plan_graph core: session graph store, tool operations, and delegation
 * guard decisions. Platform-neutral — the OpenCode plugin and the pi
 * extension both wrap this module.
 *
 * Binding token (embedded by the parent in every delegation prompt):
 *   [graph:<taskId>@r<revision>]
 */
import {
  validateGraph,
  topoBatches,
  computeReady,
  applyStatus,
  renderTextDag,
  renderMermaid,
} from "./dag.mjs";

export const READ_ONLY_ROLES = new Set([
  "explore",
  "librarian",
  "metis",
  "momus",
  "oracle",
  "multimodal-looker",
]);

const TOKEN_RE = /\[graph:([A-Za-z0-9_.-]+)@r(\d+)\]/;

export class GraphStore {
  constructor() {
    this.sessions = new Map(); // sessionID -> state
  }

  state(sessionID) {
    return this.sessions.get(sessionID);
  }

  /** define: register/replace the session graph. */
  define(sessionID, tasks, parentAgent) {
    const v = validateGraph(tasks);
    if (!v.ok) return { ok: false, error: `invalid graph: ${v.errors.join("; ")}` };
    this.sessions.set(sessionID, {
      revision: 1,
      tasks: structuredClone(v.tasks).map((t) => ({ ...t, status: "pending" })),
      results: new Map(),
      parentAgent: parentAgent ?? "build",
    });
    return this.render(sessionID);
  }

  /** update: add/modify nodes; completed/failed nodes and their results survive. */
  update(sessionID, tasks) {
    const st = this.state(sessionID);
    if (!st) return { ok: false, error: "no graph defined; call define first" };
    const v = validateGraph(tasks);
    if (!v.ok) return { ok: false, error: `invalid graph: ${v.errors.join("; ")}` };

    const prevById = new Map(st.tasks.map((t) => [t.id, t]));
    const next = v.tasks.map((t) => {
      const prev = prevById.get(t.id);
      // Terminal nodes keep their recorded status; fresh/edited nodes reset.
      if (prev && (prev.status === "completed" || prev.status === "failed")) {
        return { ...t, status: prev.status };
      }
      if (prev && prev.status === "in_flight") return { ...t, status: "in_flight" };
      return { ...t, status: "pending" };
    });
    st.tasks = next;
    st.revision += 1;
    return this.render(sessionID);
  }

  /** Mark a node in_flight (called when a delegation passes the guard). */
  markInFlight(sessionID, taskId) {
    const st = this.state(sessionID);
    const t = st?.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, error: `unknown task ${taskId}` };
    if (t.status !== "pending") return { ok: false, error: `task ${taskId} is ${t.status}, not pending` };
    t.status = "in_flight";
    return { ok: true };
  }

  /** record_result: parent-verified outcome for an in_flight node. */
  recordResult(sessionID, taskId, status, evidence) {
    const st = this.state(sessionID);
    if (!st) return { ok: false, error: "no graph defined" };
    const t = st.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, error: `unknown task ${taskId}` };
    if (t.status !== "in_flight") {
      return { ok: false, error: `task ${taskId} is ${t.status}; only in-flight tasks record results` };
    }
    if (!["completed", "failed"].includes(status)) {
      return { ok: false, error: "status must be completed or failed" };
    }
    if (status === "completed" && !evidence) {
      return { ok: false, error: "completed requires evidence (what the parent verified and how)" };
    }
    const r = applyStatus(st.tasks, taskId, status);
    if (!r.ok) return r;
    st.results.set(taskId, { status, evidence: evidence ?? null, at: new Date().toISOString() });
    return this.ready(sessionID);
  }

  /** ready view with the current revision for token freshness. */
  ready(sessionID) {
    const st = this.state(sessionID);
    if (!st) return { ok: false, error: "no graph defined" };
    const inFlight = new Set(st.tasks.filter((t) => t.status === "in_flight").map((t) => t.id));
    const { ready, notReady, blockedByFailure } = computeReady(st.tasks, inFlight);
    return {
      ok: true,
      revision: st.revision,
      ready: ready.map((t) => ({ id: t.id, title: t.title, agent: t.agent, binding: token(t.id, st.revision) })),
      notReady,
      blockedByFailure: [...blockedByFailure],
    };
  }

  /** render: text DAG + mermaid + batches. */
  render(sessionID) {
    const st = this.state(sessionID);
    if (!st) return { ok: false, error: "no graph defined" };
    const ready = this.ready(sessionID);
    return {
      ok: true,
      revision: st.revision,
      batches: topoBatches(st.tasks),
      textDag: renderTextDag(st.tasks),
      mermaid: renderMermaid(st.tasks),
      ready: ready.ready,
      notReady: ready.notReady,
    };
  }

  /** inspect: full state incl. recorded results. */
  inspect(sessionID) {
    const st = this.state(sessionID);
    if (!st) return { ok: false, error: "no graph defined" };
    return {
      ok: true,
      revision: st.revision,
      parentAgent: st.parentAgent,
      tasks: st.tasks,
      results: Object.fromEntries(st.results),
    };
  }

  /**
   * Delegation guard. `input` = { agent, prompt, isChildSession }.
   * Returns { ok: true, task } or { ok: false, error, hint }.
   */
  checkDelegation(sessionID, input) {
    const hint = "Re-run plan_graph render/ready and embed the fresh binding token in the delegation prompt.";
    if (input?.isChildSession) {
      return { ok: false, error: "subagent sessions cannot delegate", hint: "report back to the parent instead" };
    }
    const st = this.state(sessionID);
    if (!st) {
      return {
        ok: false,
        error: "no plan graph registered for this session",
        hint: "call plan_graph define with the task DAG before delegating",
      };
    }
    const agent = input.agent;
    if (st.parentAgent === "prometheus" && agent === "builder") {
      return {
        ok: false,
        error: "prometheus plans; it never spawns builder",
        hint: "record the implementation task in the plan; the user's build session executes it",
      };
    }
    const m = TOKEN_RE.exec(input.prompt ?? "");
    if (!m) {
      return {
        ok: false,
        error: "delegation prompt missing task binding token",
        hint: "embed the token from plan_graph ready, e.g. [graph:<task>@r<revision>]",
      };
    }
    const [, taskId, revStr] = m;
    const rev = Number(revStr);
    if (rev !== st.revision) {
      return { ok: false, error: `stale binding r${rev} (graph is r${st.revision})`, hint };
    }
    const task = st.tasks.find((x) => x.id === taskId);
    if (!task) return { ok: false, error: `unknown task ${taskId}`, hint: "plan_graph inspect lists current task ids" };
    if (task.agent && agent && task.agent !== agent) {
      return {
        ok: false,
        error: `task ${taskId} is assigned to ${task.agent}, not ${agent}`,
        hint: "delegate to the assigned agent or update the graph",
      };
    }
    if (task.status !== "pending") {
      return { ok: false, error: `task ${taskId} is already ${task.status}` };
    }
    const inFlight = new Set(st.tasks.filter((t) => t.status === "in_flight").map((t) => t.id));
    const { ready, notReady } = computeReady(st.tasks, inFlight);
    if (!ready.some((t) => t.id === taskId)) {
      const reasons = notReady.find((n) => n.id === taskId)?.reasons ?? ["not ready"];
      return { ok: false, error: `task ${taskId} is not ready: ${reasons.join("; ")}`, hint };
    }
    return { ok: true, task, revision: st.revision };
  }
}

export function token(taskId, revision) {
  return `[graph:${taskId}@r${revision}]`;
}

/** Tool operation dispatch shared by both platform wrappers. */
export function runOp(store, sessionID, op, args, parentAgent) {
  switch (op) {
    case "define":
      return store.define(sessionID, args?.tasks, parentAgent);
    case "update":
      return store.update(sessionID, args?.tasks);
    case "ready":
      return store.ready(sessionID);
    case "render":
      return store.render(sessionID);
    case "inspect":
      return store.inspect(sessionID);
    case "record_result":
      return store.recordResult(sessionID, args?.task_id, args?.status, args?.evidence);
    default:
      return { ok: false, error: `unknown op ${op}` };
  }
}
