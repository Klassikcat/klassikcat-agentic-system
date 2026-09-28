---
name: ulw-plan
description: "Lean planning workflow for Prometheus: ground → gap-check → approval gate → one decision-complete plan with a task DAG, then review. Use when prometheus is planning."
---

# ulw-plan — lean planning workflow

You turn a request into ONE decision-complete plan. This skill is the floor
beneath the agent contract: the workflow order, the approval gate, the plan
template, and the review loop.

## Flow

1. **Ground.** Fan out read-only research (`explore` repo, `librarian` external)
   with bounded briefs. Discoverable facts are researched and cited, never
   asked. Only genuine owner-decisions reach the user — irreversible or
   destructive choices, public contracts, budget, scale, compliance — each with
   a recommended default. When the outcome itself is fuzzy, adopt announced
   best-practice defaults instead of interviewing.
2. **Ideal state.** Name who the result serves and how; write the state where
   nothing snags for them, then every gap vs today. The plan exists to close
   every gap row.
3. **Gap-check.** Send the request + findings to `metis`; fold accepted gaps in
   silently.
4. **Approval gate.** Present the brief once — user, ideal state, gaps,
   decisions (taken / defaulted / open), approach — then WAIT for the explicit
   okay. Approval authorizes writing the plan file only. A still-unclear reply
   gets one line naming the pending action, not a re-brief.
5. **Plan.** Build the task DAG with `plan_graph define`, then write the plan
   file below. One request → one file, however large.
6. **Review.** `momus` on the saved plan; add `oracle` when the request demands
   high accuracy or intent was fuzzy. Fix eligible blockers, resubmit, cap 5
   rounds, then surface the rest.
7. **Hand off.** Summarize and stop; execution belongs to the user's build
   session.

## Task DAG rules

Every delegation is a graph node: `{ id, title, agent, depends_on, write_paths,
deliverable, acceptance }`. Independent nodes run in parallel branches; a node
is delegated only when `plan_graph ready` lists it, with its binding token
embedded in the delegation prompt. Record results only after verifying the
child's evidence yourself (`plan_graph record_result`). Rework appends new
nodes — never backward edges.

## Plan template (`.omo/plans/<slug>.md`)

```markdown
# <slug> — Work Plan
## TL;DR (For humans)
## Scope
### Affected user and ideal state
### Must have
### Must NOT have
## Verification strategy
## Execution strategy
<!-- paste plan_graph render output: text DAG + mermaid -->
## Todos
- [ ] 1. <title> — refs, acceptance, QA (tool+steps+expected), agent, commit line
## Final verification wave
- [ ] F1. Plan compliance audit — F2. Code quality — F3. Real QA — F4. Scope fidelity
## Commit strategy
## Success criteria
```

Rules: implementation+test is ONE todo; every todo cites exhaustive references
(executors have no interview context), an agent-executable QA scenario with a
failure path, and a commit line; the final wave runs read-only, in parallel,
after all todos. Effort bands (Quick/Short/Medium/Large/XL), never durations.
QA never requires a human.

## Draft

Record `intent`, decisions, and the gate state in `.omo/drafts/<slug>.md` as you
go; on any later turn resume from it rather than re-deriving. Delete the draft
when the plan is delivered.
