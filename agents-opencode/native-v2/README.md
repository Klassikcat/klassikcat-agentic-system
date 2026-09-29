# native-v2 — lean OMO planning stack for OpenCode V2 and pi

Lean native port of the Oh-My-OpenAgent planning stack (pinned upstream
`v5.0.1`; see [UPSTREAM.md](./UPSTREAM.md) for the full mapping). Two harnesses
share one set of role definitions and one DAG engine.

- **OpenCode V2**: `prometheus` primary + 7 subagents (`explore`, `librarian`,
  `metis`, `momus`, `oracle`, `multimodal-looker`, `builder`), the `ulw-plan`
  skill, and a `plan_graph` plugin (tool + delegation guard).
- **pi (oh-my-pi)**: the same 8 roles as pi agent definitions plus the
  `plan_graph` extension (`pi.registerTool` + `pi.on("tool_call")` guard).

Roles are authored once in [`roles/`](./roles) and generated per platform
(`agents/` for OpenCode, `generated-pi/` for pi) — never hand-edit the
generated files; run `npm run generate`.

## What "lean" means here

Same models, same quality gates, less overhead ([CONTRACT.md](./CONTRACT.md)):

- no fixed minimum tool-call counts, unconditional re-reads, or broad skill loading
- no recursive delegation from subagents (permission-denied, plus the guard)
- bounded briefs to fresh-context children instead of parent transcripts
- `builder` executes ONE bounded task and reports `PASS/FAIL/SKIPPED/BLOCKED`
  with evidence; skipping verification is never "lightweight success"

## Delegation DAG

Before any delegation, the session registers a task DAG via `plan_graph` and
embeds each node's binding token (`[graph:<task>@r<rev>]`) in the delegation
prompt. The guard rejects: no graph, missing/stale token, not-ready
dependencies, in-flight duplicates, write-path conflicts, and
`prometheus → builder`. Rework appends new nodes — never backward edges.

## Install

OpenCode (global config dir; a project `.opencode/` works the same way):

```bash
node scripts/install.mjs --platform opencode --target ~/.config/opencode --dry-run
node scripts/install.mjs --platform opencode --target ~/.config/opencode
```

Then add to `opencode.json`:

```jsonc
{
  "plugins": ["<abs-path>/agents-opencode/native-v2/plugin"],
  "agents": {
    "builder": { "model": "openai/gpt-6-luna#max" },
    "prometheus": { "model": "zai-coding-plan/glm-5.3" }
  }
}
```

Role models come from `agents.<id>.model` in your `opencode.json`
(`provider/model#variant`); defaults for every role are in
[opencode.example.jsonc](./opencode.example.jsonc). Re-running install never
touches them. Invalid model/variant → visible BLOCKED report, never a silent
substitute.

pi (agents + the plan-graph extension, for `@earendil-works/pi-coding-agent`):

```bash
node scripts/install.mjs --platform pi --target ~/.pi/agent/agents --pi-extensions ~/.pi/agent/extensions
```

Then load `pi-extension/plan-graph.js` from your pi config (see
[../agents-pi/README.md](../../agents-pi/README.md) for the extension API's
OMP version caveats).

## Usage

- **Plan**: start `prometheus` (pick its model explicitly — a primary agent
  does not switch the session model by itself). It explores through the
  read-only roles, gap-checks with `metis`, gates on your approval, writes one
  plan under `.omo/plans/`, and reviews it with `momus` (+`oracle` for high
  accuracy).
- **Execute**: your normal `build` session runs the plan, delegating each
  ready DAG node to `builder`. `prometheus` itself never spawns `builder`.

## Develop

```bash
npm test            # 34 tests: DAG engine, graph tool, guards, structure, install
npm run check       # syntax + generation drift + bundle integrity + tests
npm run generate    # regenerate agents/ + generated-pi/ from roles/
node scripts/smoke.mjs   # live host: registration, modes, models, permissions, skill, plugin
```

The OMO plugin (oh-my-openagent) can stay installed; these definitions are
standalone. To avoid duplicate `prometheus`/`explore` ids, disable the OMO
copies or install into a project config that wins config precedence.
