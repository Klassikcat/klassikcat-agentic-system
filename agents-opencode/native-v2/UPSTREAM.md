# UPSTREAM — sources and adaptations

Pinned source: `code-yeongyu/oh-my-openagent` tag `v5.0.1`, tree SHA
`ab725f3299cd5ba8727a999817db8f9d856f2440`. License: Sustainable Use License v1.0
(personal/internal use; redistribution free of charge for non-commercial purposes;
license notices preserved in this file).

## Role mapping

| native-v2 | upstream source (packages/…) | adaptation |
| --- | --- | --- |
| `agents/prometheus.md` | `prompts-core/prompts/prometheus/default.md` + `shared-skills/skills/ulw-plan/**` | planner doctrine condensed into agent body; workflow moved into `skills/ulw-plan`; `.omo` plan paths kept; OMO-only tool names mapped to native ones; execution handoff retargeted from `/ulw-execute`/Atlas to user's `build` primary |
| `agents/explore.md` | `omo-opencode/src/agents/explore.ts` | dropped: mandatory 3+ parallel first calls, `<analysis>` ritual, absolute-path-only rule (repo-relative kept); kept: parallel search guidance, file+line evidence, "answer the actual need", read-only |
| `agents/librarian.md` | `omo-opencode/src/agents/librarian.ts` | dropped: TYPE A–D ceremony, mandatory sitemap discovery pass, grep.app/context7 tool names (not present here); kept: official-source preference, version awareness, permalink/URL citation, uncertainty statement |
| `agents/metis.md` | `omo-opencode/src/agents/metis.ts` | dropped: intent classification phase (parent's job), LSP tool names, nested explore fan-out (parent fans out); kept: gap categories (missing reqs, contradictions, constraints, scope creep, assumptions, acceptance criteria) |
| `agents/momus.md` | `omo-opencode/src/agents/momus.ts` + `momus-gpt-5-6.ts` | merged default+GPT variants into one compact doctrine; kept: single-plan-path input contract, re-read on follow-up, 4 checks, blocker-only rejection, max 3 issues, OKAY bias |
| `agents/oracle.md` | `omo-opencode/src/agents/oracle.ts` | dropped: verbosity spec repetition, filler examples; kept: answer-only-what-was-asked, confidence tagging, action plan, read-only, sparing tool use on genuine gaps |
| `agents/multimodal-looker.md` | `omo-opencode/src/agents/multimodal-looker.ts` | `look_at` attachment flow replaced with native `read` of an explicitly referenced local media path (V2 has no look_at); kept: extract-only-what-was-asked, no tools during analysis, missing-info statement |
| `agents/builder.md` | `omo-opencode/src/agents/sisyphus-junior/**` (renamed) | renamed sisyphus-junior→builder (per user decision); merged 9 per-provider prompt variants into one model-agnostic executor contract (default `openai/gpt-6-luna#max`, verified active with `max` variant); dropped: mandatory 2–5 background research children (parent owns research), todo/task bureaucracy, LSP diagnostics (absent in V2 — project lint/typecheck/test commands used instead), Manual QA Gate per-surface catalog (kept: run the project's real checks + exercise the changed behavior); kept: one bounded task, smallest coherent change, scope discipline, dirty-worktree preservation, truthful verification reporting |
| `skills/ulw-plan/*` | `shared-skills/skills/ulw-plan/{SKILL.md,references/full-workflow.md}` | condensed to one SKILL.md + references/workflow.md; OMO `task()` syntax → native subagent calls with bounded briefs; momus/oracle dual review semantics preserved but delegated through parent; plan template headers preserved |
| `plugin/*` (plan_graph + delegation guard) | — (new, no upstream equivalent) | new DAG engine + `plan_graph` tool + `tool.execute.before` delegation guard implementing the CONTRACT delegation rules |

## Deliberately NOT ported

- Sisyphus / Hephaestus / Atlas primaries and their registration coupling.
- OMO plugin runtime: model fallback chains, tmux, boulder state, background tasks, hooks.
- Category router (`quick`/`deep`/…) — the parent sizes briefs instead.
- `sisyphus-junior` per-model prompt switching (single contract; model set in JSON).

## Baseline for comparative evaluation

The A/B baseline uses the upstream prompts above with only the host-required
adaptations (tool names, plan paths, handoff target) — compression is the
candidate's delta. Both arms run the same models (`builder`: `openai/gpt-6-luna#max`).
