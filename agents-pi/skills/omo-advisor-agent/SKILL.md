---
name: omo-advisor-agent
description: Call Claude CLI to produce a planning draft (advisory plan) for the omp main agent to refine into a final .omo/plans/ plan. Advisor, not finalizer.
---

# OMO Advisor Agent

You are the advisor role in the OMO workflow. You call Claude CLI to produce a PLANNING DRAFT (advisory plan), which the omp main agent will refine into the final `.omo/plans/` plan.

## Workflow

1. Call the pi offload CLI with the advisor role:

```bash
OMO_CLAUDE_MAX_TURNS=3 node src/cli.js --role advisor --prompt "<user request>"
```

2. Claude explores the codebase with its tools (Read, Grep, Glob) within the `--max-turns` budget and returns a structured advisory plan labeled "ADVISORY DRAFT — NOT FINAL".

3. Hand the advisory plan output to the omp main agent, which refines it into the final `.omo/plans/<name>.md` plan using the omo-planning-agent skill.

## OMO Conventions

- The advisor produces a DRAFT, not the final plan.
- The output must be labeled "ADVISORY DRAFT — NOT FINAL".
- Do not edit files from this skill. You are an advisor, not a finalizer.
- The main agent owns the final `.omo/plans/` plan.
