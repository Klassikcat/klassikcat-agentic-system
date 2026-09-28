# Evaluation rubric — lean vs baseline

**Comparison unit:** minimally host-adapted upstream prompt (baseline) vs the
lean native prompt (candidate). Both arms run the same model per role
(`builder`: `openai/gpt-6-luna#max`), same repo state, same case briefs,
same harness (the installed native-v2 agents; baseline swaps only the system
prompt via `eval/baselines/<role>.md`). Baseline prompts are extracts of the
pinned upstream `v5.0.1` role sources (see UPSTREAM.md for exact files) —
host-required adaptations only (tool names, plan paths, handoff target).
Compression is the candidate's delta.

## Rules (from the implementation plan)

1. **Freeze before confirmation.** After the pilot (2 cases × 2 arms), cases,
   rubric, both arms' prompts, and model config freeze. Any later change
   re-runs affected automated tests + host smoke and discards stale evidence.
   Reports never mix candidate revisions.
2. **Budget gate.** `--execute` refuses to run without explicit
   `--max-runs` and `--max-cost-usd`. The runner checks the cumulative spend
   before each dispatch and stops launching at the limit; exhaustion is
   reported as BLOCKED/INCOMPLETE — never PASS, never a silently reduced suite.
3. **Quality first.** Every case's `expect` assertions must pass in the
   candidate arm. A required-case failure blocks acceptance regardless of
   token savings; unexplained per-role cost increases get flagged.
4. **No averaging away failures.** Failed assertions are reported raw;
   medians describe passing runs only.

## Case verdicts

- **Deterministic asserts** (verdict strings, status enums, cited URL count,
  plan-file existence, DAG presence, files touched, user-edit preservation):
  checked mechanically from the recorded transcript/artifacts.
- **Semantic asserts** (`no_fabricated_paths`, `truthful_status`,
  `no_invented_date`, `flags_missing_outcome`): judged against this rubric by
  the operator from the raw transcript; the report records the judgment and
  the supporting quote.

## Metrics

Per case × arm: assistant-model id+variant, tokens
(input/output/reasoning/cache.read/cache.write) and cost summed across the
**whole session tree** (parent + descendants), tool-call count, wall time,
steps. Missing usage is recorded `null` — never zero. Incomplete trials are
excluded from savings math and counted separately.

## Efficiency reporting

Per-role and total: candidate/baseline ratio for static prompt size (chars,
proxy) and measured whole-tree tokens; absolute deltas, medians over repeats.
The 30% static shrinkage figure is a target for long prompts only — short
roles are reported as-is; no percentage is promised for total usage.

## Fixtures

`eval/fixtures/` provides the throwaway repo states per case
(`mini-project*`, momus plan files, diagram). Fixtures are reset to a clean
copy before every trial; `mini-project-dirty` deliberately contains a user
edit in `NOTES.md` that must survive.
