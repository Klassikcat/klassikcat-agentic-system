/**
 * Platform mapping for native-v2 roles: frontmatter + permission grants
 * for opencode (V2) and pi (oh-my-pi). Shared by bin/generate-agents.mjs
 * and the structural tests.
 *
 * Models:
 * - opencode: NOT set in generated markdown; defaults live in
 *   opencode.example.jsonc (agents.<id>.model) so users customize models in
 *   one JSON place (CONTRACT.md "Model policy").
 * - pi: pi model roles follow the repository convention (pi/default, pi/smol,
 *   pi/slow) as seen in agents-pi/agents/*.md.
 */

const READ_ONLY_DENY = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
];

const OPENCODE = {
  prometheus: {
    mode: "primary",
    model: "zai-coding-plan/glm-5.3",
    permissions: [
      // Plan-artifact writes only; broad rules first, exceptions last.
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: ".omo/**", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "subagent", resource: "builder", effect: "deny" },
    ],
  },
  explore: {
    mode: "subagent",
    model: "opencode-go/deepseek-v4-flash",
    permissions: READ_ONLY_DENY,
  },
  librarian: {
    mode: "subagent",
    model: "opencode-go/deepseek-v4-flash",
    permissions: READ_ONLY_DENY,
  },
  metis: {
    mode: "subagent",
    model: "openai/gpt-5.6-terra",
    permissions: READ_ONLY_DENY,
  },
  momus: {
    mode: "subagent",
    model: "openai/gpt-6-astra#high",
    permissions: READ_ONLY_DENY,
  },
  oracle: {
    mode: "subagent",
    model: "openai/gpt-5.6-terra#xhigh",
    permissions: READ_ONLY_DENY,
  },
  "multimodal-looker": {
    mode: "subagent",
    model: "openrouter/google/gemini-3.5-flash",
    permissions: READ_ONLY_DENY,
  },
  builder: {
    mode: "subagent",
    model: "openai/gpt-6-luna#max",
    permissions: [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  },
};

const PI = {
  // pi (@earendil-works/pi-coding-agent) agent schema, read by the subagent
  // extension from ~/.pi/agent/agents: name, description, tools (csv),
  // model, fallbackModels (csv). No OMP-only fields (thinking-level etc).
  prometheus: { tools: "read, search, find, edit, write", model: "pi/default" },
  explore: { tools: "read, search, find", model: "pi/smol" },
  librarian: { tools: "read, web_search, search, find", model: "pi/smol" },
  metis: { tools: "read, search, find", model: "pi/default" },
  momus: { tools: "read, search, find", model: "pi/default" },
  oracle: { tools: "read, search, find", model: "pi/slow" },
  "multimodal-looker": { tools: "read", model: "pi/smol" },
  builder: { tools: "read, search, find, edit, write, bash", model: "pi/default" },
};

export const ROSTER = [
  "prometheus",
  "explore",
  "librarian",
  "metis",
  "momus",
  "oracle",
  "multimodal-looker",
  "builder",
];

function grantFor(platform, id) {
  const grants = platform[id];
  if (!grants) throw new Error(`No ${platform === OPENCODE ? "opencode" : "pi"} grants for role ${id}`);
  return grants;
}

/** YAML double-quoted scalar: survives colons, quotes, and backslashes. */
function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const PLATFORMS = {
  opencode: {
    outPath(id) {
      return `agents/${id}.md`;
    },
    frontmatter(meta) {
      const grant = grantFor(OPENCODE, meta.id);
      const lines = [
        "---",
        `description: ${yamlQuote(meta.descriptionOpencode)}`,
        `mode: ${grant.mode}`,
        // Markdown carries the DEFAULT model so it survives plugins that
        // rebuild config.agent; opencode.json agents.<id>.model still wins
        // in a stock setup (config merges after file agents).
        ...(grant.model ? [`model: ${grant.model}`] : []),
      ];
      if (grant.permissions?.length) {
        lines.push("permissions:");
        for (const p of grant.permissions) {
          lines.push(`  - action: ${p.action}`);
          lines.push(`    resource: "${p.resource}"`);
          lines.push(`    effect: ${p.effect}`);
        }
      }
      lines.push("---", "");
      return lines.join("\n");
    },
  },
  pi: {
    outPath(id) {
      return `generated-pi/${id}.md`;
    },
    frontmatter(meta) {
      const grant = grantFor(PI, meta.id);
      return [
        "---",
        `name: ${meta.id}`,
        `description: ${yamlQuote(meta.descriptionPi)}`,
        `tools: ${grant.tools}`,
        `model: ${grant.model}`,
        "---",
        "",
      ].join("\n");
    },
  },
};

/** Role metadata + body parsed from roles/<id>.md by the generator. */
export function parseRole(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error("role file missing frontmatter");
  const fm = m[1];
  const body = text.slice(m[0].length).replace(/^\n+/, "");
  const pick = (key) => {
    const line = fm.split("\n").find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  };
  const id = pick("id");
  if (!id) throw new Error("role file missing id");
  return {
    id,
    summary: pick("summary"),
    descriptionOpencode: pick("descriptionOpencode"),
    descriptionPi: pick("descriptionPi"),
    body,
  };
}
