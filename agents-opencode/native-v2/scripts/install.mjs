#!/usr/bin/env node
/**
 * Install native-v2 agents into a target harness configuration directory.
 *
 * OpenCode:   agents/*.md        → <target>/agents/<id>.md
 *             skills/ulw-plan/   → <target>/skills/ulw-plan/
 *             plugin/            → load via opencode.json "plugins" (printed)
 * pi:         generated-pi/*.md  → <target>/<id>.md
 *
 * Safety:
 *   - --dry-run prints the plan only.
 *   - A target file that exists and differs is USER-OWNED: skipped unless
 *     it is listed in our own manifest (then updated) or --force is passed.
 *   - A .native-v2-manifest.json records what we own; reinstall updates
 *     exactly those files, never user models or unrelated agents.
 *
 * Usage:
 *   node scripts/install.mjs --platform opencode --target ~/.config/opencode [--dry-run] [--force]
 *   node scripts/install.mjs --platform pi --target ~/.omp/agent/agents [--dry-run] [--force]
 *   node scripts/install.mjs --check   # local bundle integrity only
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROSTER } from "../lib/platforms.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const MANIFEST = ".native-v2-manifest.json";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function loadManifest(target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, MANIFEST), "utf8"));
  } catch {
    return { files: [] };
  }
}

function install(platform, target, { dryRun, force }) {
  const manifest = loadManifest(target);
  const owned = new Set(manifest.files ?? []);
  const actions = [];

  const add = (srcRel, destAbs) => actions.push({ src: path.join(pkgRoot, srcRel), dest: destAbs });

  if (platform === "opencode") {
    for (const id of ROSTER) add(`agents/${id}.md`, path.join(target, "agents", `${id}.md`));
    add("skills/ulw-plan", path.join(target, "skills", "ulw-plan"));
  } else if (platform === "pi") {
    for (const id of ROSTER) add(`generated-pi/${id}.md`, path.join(target, `${id}.md`));
  } else {
    fail(`unknown platform ${platform}`);
  }

  const results = { write: [], skip: [], error: [] };
  for (const { src, dest } of actions) {
    if (!fs.existsSync(src)) {
      results.error.push(`missing source ${path.relative(pkgRoot, src)}`);
      continue;
    }
    const destRel = path.relative(target, dest);
    const isDir = fs.statSync(src).isDirectory();
    const same =
      !isDir &&
      fs.existsSync(dest) &&
      fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8");

    if (same) {
      results.skip.push(`${destRel} (identical)`);
      continue;
    }
    if (fs.existsSync(dest) && !owned.has(destRel) && !force) {
      results.skip.push(`${destRel} (user-owned; --force to replace)`);
      continue;
    }
    if (dryRun) {
      results.write.push(`${destRel} (dry-run)`);
      continue;
    }
    if (isDir) fs.cpSync(src, dest, { recursive: true, force: true });
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(src));
    }
    results.write.push(destRel);
    owned.add(destRel);
  }

  if (results.error.length) {
    for (const e of results.error) console.error(`ERROR: ${e}`);
    process.exitCode = 1;
  }
  for (const s of results.skip) console.log(`skip  ${s}`);
  for (const w of results.write) console.log(`write ${w}`);

  if (!dryRun && (results.write.length || !fs.existsSync(path.join(target, MANIFEST)))) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, MANIFEST), JSON.stringify({ files: [...owned].sort() }, null, 2));
  }

  if (platform === "opencode" && !dryRun) {
    console.log(`
next steps:
  1. add the plugin to opencode.json:
     "plugins": ["${path.join(pkgRoot, "plugin")}"]
  2. merge role models from opencode.example.jsonc into your opencode.json
     (builder default: openai/gpt-6-luna#max) — re-running install never touches them.
  3. pick prometheus + its model explicitly when starting a planning session.`);
  }
  if (platform === "pi" && !dryRun) {
    console.log(`
next steps:
  1. load the plan-graph extension in your pi config (pi-extension/plan-graph.js).
  2. pi model roles (pi/default, pi/smol, pi/slow) must exist in your pi config.`);
  }
}

/* --check: bundle integrity without touching any target. */
function check() {
  let ok = true;
  for (const id of ROSTER) {
    for (const f of [`roles/${id}.md`, `agents/${id}.md`, `generated-pi/${id}.md`]) {
      if (!fs.existsSync(path.join(pkgRoot, f))) {
        console.error(`missing ${f}`);
        ok = false;
      }
    }
  }
  for (const f of ["plugin/index.js", "pi-extension/plan-graph.js", "skills/ulw-plan/SKILL.md", "opencode.example.jsonc"]) {
    if (!fs.existsSync(path.join(pkgRoot, f))) {
      console.error(`missing ${f}`);
      ok = false;
    }
  }
  process.exit(ok ? 0 : 1);
}

if (flag("check")) {
  check();
} else {
  const platform = val("platform");
  const target0 = val("target");
  if (!platform || !target0) fail("usage: install.mjs --platform opencode|pi --target <dir> [--dry-run] [--force] | --check");
  const target = target0.startsWith("~") ? path.join(process.env.HOME ?? "", target0.slice(1)) : target0;
  install(platform, target, { dryRun: flag("dry-run"), force: flag("force") });
}
