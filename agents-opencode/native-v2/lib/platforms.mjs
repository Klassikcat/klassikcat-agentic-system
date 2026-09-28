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
    permissions: READ_ONLY_DENY,
  },
  librarian: {
    mode: "subagent",
    permissions: READ_ONLY_DENY,
  },
  metis: {
    mode: "subagent",
    permissions: READ_ONLY_DENY,
  },
  momus: {
    mode: "subagent",
    permissions: READ_ONLY_DENY,
  },
  oracle: {
    mode: "subagent",
    permissions: READ_ONLY_DENY,
  },
  "multimodal-looker": {
    mode: "subagent",
    permissions: READ_ONLY_DENY,
  },
  builder: {
    mode: "subagent",
    permissions: [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  },
};

const PI = {
  prometheus: { tools: "read, search, find, edit, write", model: "pi/default", thinkingLevel: "high" },
  explore: { tools: "read, search, find", model: "pi/smol", thinkingLevel: "low" },
  librarian: { tools: "read, web_search, search, find", model: "pi/smol", thinkingLevel: "low" },
  metis: { tools: "read, search, find", model: "pi/default", thinkingLevel: "medium" },
  momus: { tools: "read, search, find", model: "pi/default", thinkingLevel: "medium" },
  oracle: { tools: "read, search, find", model: "pi/slow", thinkingLevel: "high" },
  "multimodal-looker": { tools: "read", model: "pi/smol", thinkingLevel: "low" },
  builder: { tools: "read, search, find, edit, write, bash, lsp", model: "pi/default", thinkingLevel: "medium" },
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
        `thinking-level: ${grant.thinkingLevel}`,
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
