/**
 * DAG engine for plan_graph: validation, topo batching, readiness,
 * write-conflict detection, and rendering. Pure functions, no I/O.
 *
 * Node status lifecycle:
 *   pending → in_flight → completed | failed
 *   pending → skipped            (explicitly skipped)
 *   blocked is DERIVED (a pending node whose transitive deps contain a
 *   failed/skipped-without-substitute node), never stored.
 */

export const TERMINAL_OK = new Set(["completed", "skipped"]);

/**
 * Validate a task list as a DAG. Returns { ok: true, tasks } or
 * { ok: false, errors: string[] }.
 */
export function validateGraph(tasks) {
  const errors = [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, errors: ["graph must contain at least one task"] };
  }
  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t !== "object") {
      errors.push("task entries must be objects");
      continue;
    }
    if (typeof t.id !== "string" || t.id.length === 0) {
      errors.push("every task needs a non-empty string id");
      continue;
    }
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (typeof t.title !== "string" || t.title.length === 0) {
      errors.push(`task ${t.id}: missing title`);
    }
    if (typeof t.agent !== "string" || t.agent.length === 0) {
      errors.push(`task ${t.id}: missing agent`);
    }
    if (!Array.isArray(t.depends_on)) {
      errors.push(`task ${t.id}: depends_on must be an array`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // Unknown references and self-edges.
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (dep === t.id) errors.push(`task ${t.id}: self-dependency`);
      else if (!ids.has(dep)) errors.push(`task ${t.id}: unknown dependency ${dep}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // Cycle detection via iterative DFS with colors.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(tasks.map((t) => [t.id, WHITE]));
  const stack = [...tasks.map((t) => t.id)];
  const adj = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]));
  while (stack.length) {
    const id = stack[stack.length - 1];
    if (color.get(id) === BLACK) {
      stack.pop();
      continue;
    }
    color.set(id, GRAY);
    let pushed = false;
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) {
        errors.push(`cycle detected involving ${id} → ${dep}`);
      } else if (c === WHITE) {
        stack.push(dep);
        pushed = true;
      }
    }
    if (!pushed) {
      color.set(id, BLACK);
      stack.pop();
    }
    if (errors.length) return { ok: false, errors: dedupe(errors) };
  }
  return { ok: true, tasks };
}

/** Topologically sorted batches: batch N runs after all of batch N-1. */
export function topoBatches(tasks) {
  const v = validateGraph(tasks);
  if (!v.ok) throw new Error(`invalid graph: ${v.errors.join("; ")}`);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set();
  const batches = [];
  let remaining = tasks.map((t) => t.id);
  while (remaining.length) {
    const batch = remaining.filter((id) =>
      (byId.get(id).depends_on ?? []).every((d) => placed.has(d)),
    );
    if (batch.length === 0) throw new Error("unreachable: validated graph cannot batch");
    batches.push(batch);
    for (const id of batch) placed.add(id);
    remaining = remaining.filter((id) => !placed.has(id));
  }
  return batches;
}

/** All ids reachable from `id` following depends_on edges (inclusive of id). */
export function ancestors(tasks, id) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const walk = (x) => {
    if (seen.has(x)) return;
    seen.add(x);
    for (const dep of byId.get(x)?.depends_on ?? []) walk(dep);
  };
  walk(id);
  return seen;
}

/**
 * Compute readiness for every node.
 * Returns { ready: Task[], notReady: [{id, reasons[]}], blockedByFailure: Set }
 */
export function computeReady(tasks, inFlight = new Set()) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ready = [];
  const notReady = [];
  const blockedByFailure = new Set();

  const failedAncestor = (id) => {
    for (const a of ancestors(tasks, id)) {
      const st = byId.get(a)?.status;
      if (st === "failed" || (st === "skipped" && !isSubstituted(tasks, a, id))) return a;
    }
    return null;
  };

  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const reasons = [];
    for (const dep of t.depends_on ?? []) {
      const st = byId.get(dep)?.status;
      if (!TERMINAL_OK.has(st)) reasons.push(`dependency ${dep} is ${st ?? "unknown"}`);
    }
    const failAnc = failedAncestor(t.id);
    if (failAnc) reasons.push(`ancestor ${failAnc} failed or was skipped`);
    if (inFlight.has(t.id)) reasons.push("already in flight");
    for (const f of inFlight) {
      const clash = pathsOverlap(byId.get(f)?.write_paths, t.write_paths);
      if (clash) reasons.push(`write path ${clash} conflicts with in-flight ${f}`);
    }
    if (reasons.length === 0) ready.push(t);
    else {
      notReady.push({ id: t.id, reasons });
      if (failAnc) blockedByFailure.add(t.id);
    }
  }
  return { ready, notReady, blockedByFailure };
}

function isSubstituted(_tasks, _ancestorId, _targetId) {
  // Skipped deps block downstream unless the parent explicitly recorded a
  // completed substitute; keep strict default (skipped blocks).
  return false;
}

function pathsOverlap(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return null;
  for (const x of a) {
    for (const y of b) {
      if (x === y) return x;
      // Directory prefixes: "src/a/" conflicts with "src/a/b.ts".
      if (x.endsWith("/") && y.startsWith(x)) return x;
      if (y.endsWith("/") && x.startsWith(y)) return y;
    }
  }
  return null;
}

/**
 * Render an ASCII DAG with explicit fan-out/fan-in. Independent nodes in the
 * same batch render side by side; arrows show dependency flow (dep → node).
 */
export function renderTextDag(tasks) {
  const batches = topoBatches(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const lines = [];

  batches.forEach((batch, bi) => {
    if (bi > 0) {
      // Fan-in summary line: which upstream ids feed each node in this batch.
      const arrows = batch.map((id) => {
        const deps = byId.get(id)?.depends_on ?? [];
        return `${id}${deps.length ? ` ← ${deps.join("+")}` : ""}`;
      });
      lines.push("      " + arrows.join("   |   "));
      lines.push("      " + batch.map(() => "▼").join("       "));
    }
    lines.push("  ┌─ " + cell(byId, batch[0]));
    for (let i = 1; i < batch.length; i++) lines.push("  ├─ " + cell(byId, batch[i]));
    lines.push("  └─");
  });
  return lines.join("\n");
}

function cell(byId, id) {
  const t = byId.get(id);
  return `${id}. ${t.title} [${t.agent}] ${statusMark(t.status)}`;
}

function statusMark(status) {
  switch (status) {
    case "completed": return "{done}";
    case "in_flight": return "{running}";
    case "failed": return "{FAILED}";
    case "skipped": return "{skipped}";
    default: return "{pending}";
  }
}

/** Mermaid flowchart from the same graph data (dep → node direction). */
export function renderMermaid(tasks) {
  const batches = topoBatches(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const q = (s) => `"${String(s).replace(/"/g, "'")}"`;
  const lines = ["flowchart TD"];
  batches.flat().forEach((id) => {
    const t = byId.get(id);
    lines.push(`  ${id}[${q(statusMark(t.status) + " " + t.title + " · " + t.agent)}]`);
  });
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) lines.push(`  ${dep} --> ${t.id}`);
  }
  return lines.join("\n");
}

/** Apply a node status transition with basic lifecycle checks. */
export function applyStatus(tasks, id, next) {
  const allowed = {
    pending: ["in_flight", "skipped"],
    in_flight: ["completed", "failed"],
    completed: [],
    failed: ["pending"], // re-open only via explicit parent decision
    skipped: [],
  };
  const t = tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: `unknown task ${id}` };
  const legal = allowed[t.status] ?? [];
  if (!legal.includes(next)) {
    return { ok: false, error: `illegal transition ${t.status} → ${next} for ${id}` };
  }
  t.status = next;
  return { ok: true, task: t };
}

function dedupe(arr) {
  return [...new Set(arr)];
}
