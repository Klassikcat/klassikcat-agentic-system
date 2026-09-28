# CONTRACT — native-v2 agents

Lean native OpenCode V2 port of the Oh-My-OpenAgent (OMO) planning stack.
Pinned upstream: `v5.0.1` (tree `ab725f3299cd5ba8727a999817db8f9d856f2440`).
See [UPSTREAM.md](./UPSTREAM.md) for source mapping and adaptation notes.

## Roster (8 agents)

| ID | Mode | Role | Writes |
| --- | --- | --- | --- |
| `prometheus` | primary | Planning: clarify, explore, write ONE decision-complete plan, route reviews | plan artifacts only |
| `explore` | subagent | Repo search with file:line evidence | none |
| `librarian` | subagent | External docs/versions with cited sources | none |
| `metis` | subagent | Pre-plan gap analysis (missing reqs, contradictions, constraints) | none |
| `momus` | subagent | Plan executability review (references, blockers, QA scenarios) | none |
| `oracle` | subagent | Hard architecture/debugging consultation from supplied evidence | none |
| `multimodal-looker` | subagent | Targeted interpretation of referenced local media files | none |
| `builder` | subagent | ONE bounded implementation task + verification | task scope only |

The builtin `build` primary stays the user's execution entry; it delegates `builder`.
`prometheus` never invokes `builder`.

## Model policy

- Defaults live in [opencode.example.jsonc](./opencode.example.jsonc) (`agents.<id>.model`, `provider/model#variant`), not in prompt bodies.
- `builder` default: `openai/gpt-6-luna#max`.
- Other roles keep the models resolved from the user's current settings at port time.
- Missing/invalid model or variant ⇒ visible BLOCKED report; never silently inherit, downgrade, or swap.
- Reinstall never overwrites a user-customized model entry.
- OMO automatic multi-provider fallback is NOT rebuilt; failures surface to the caller.

## Delegation contract (DAG)

Before any subagent delegation the session MUST register a task DAG via the
`plan_graph` tool and delegate only nodes whose dependencies are recorded complete.

- Nodes carry `id`, `title`, `agent`, `depends_on`, `scope`, `write_paths`, `deliverable`, `acceptance`, `status`.
- The graph is validated as a DAG: cycles, self-edges, unknown references, duplicate ids are rejected.
- Independent nodes form explicit parallel branches; fan-in nodes wait for all incoming edges.
- Delegation requests bind to `graph_id` + `revision` + `task_id`; stale revisions are rejected.
- A node is ready only when all dependencies have recorded results (with verification evidence), and no in-flight task conflicts on `write_paths`.
- Rework appends NEW nodes (fix + re-verify); backward edges are never added.
- `prometheus` may only fan out to the six read-only roles; `builder` is invoked by the executing primary (`build`).
- The tool records results the parent verified; it does not judge test truthfulness itself.

## Lightweight invariants (all subagents)

- No recursive delegation by subagents (enforced by permission deny on `subagent`).
- No fixed minimum tool-call counts, no unconditional extra re-reads, no broad skill loading.
- Prompts keep: role scope, hard rules, evidence/verification requirements, stop conditions, compact output format.
- Prompts drop: repeated emphasis blocks, long example catalogs, main-agent operating procedure.
- Status reporting distinguishes PASS / FAIL / SKIPPED / BLOCKED; skipping verification is never "lightweight success".
- Fresh-context children receive a bounded brief: goal, scope, evidence, constraints, acceptance, output shape — not the parent transcript.
- Deliverable-bearing files/plans are re-read at use time; supplied context is a hint, not truth.

## Quality gates

- Automated: `node --test` (structure, DAG engine, permissions, install, guards).
- Host: `scripts/smoke.mjs` verifies registration, modes, models, tool presence, allow/deny outcomes.
- Comparative: baseline (upstream prompts, minimally V2-adapted) vs lean, same models/repo/inputs; per-role quality assertions plus parent+child token/step/call totals. Budgeted, user-parameterized; never auto-run by `npm test`.
