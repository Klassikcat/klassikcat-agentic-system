import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve through symlinks: this file may be loaded from a symlinked extension
// directory (e.g. ~/.pi/agent/extensions/trufflehog-guard -> this repo).
const here = path.dirname(realpathSync(fileURLToPath(import.meta.url)));

const DEFAULT_TIMEOUT_MS = 20_000;
// Shared core — the same script the OpenCode plugin and the Claude Code
// PreToolUse hooks run. Single source of truth for detection logic.
const DEFAULT_SCRIPT = path.resolve(here, "../../hooks-opencode/trufflehog-guard/trufflehog-guard.py");

export function scriptPathFrom(env = process.env) {
	return env.PI_TRUFFLEHOG_GUARD_SCRIPT || DEFAULT_SCRIPT;
}

export function timeoutMsFrom(options = {}, env = process.env) {
	return Number(options.timeoutMs || env.PI_TRUFFLEHOG_GUARD_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
}

function runHook(scriptPath, payload, timeoutMs) {
	return new Promise((resolve) => {
		if (!existsSync(scriptPath)) {
			resolve(null);
			return;
		}

		const proc = spawn("python3", [scriptPath, "check"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, timeoutMs);

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		proc.on("close", () => {
			clearTimeout(timer);
			if (killed) {
				resolve(null);
				return;
			}
			try {
				resolve(JSON.parse(stdout.trim() || "{}"));
			} catch {
				resolve(null);
			}
		});

		try {
			proc.stdin.write(JSON.stringify(payload));
			proc.stdin.end();
		} catch {
			resolve(null);
		}
	});
}

/**
 * Run the guard for a pi tool call.
 *
 * @param tool pi tool name: "read" | "bash"
 * @param input pi tool input ({ path } for read, { command } for bash)
 * @param cwd current working directory
 * @param options optional overrides ({ scriptPath, timeoutMs })
 * @returns `{ deny: true, reason }` to block, `{ deny: false }` to allow.
 *   Fails open (allows) when the guard script is missing, crashes, or hangs.
 */
export async function checkToolCall(tool, input, cwd, options = {}) {
	if (typeof input !== "object" || input === null) return { deny: false };

	// pi's read tool takes `path`; the guard script speaks Claude-style
	// tool_name/tool_input (Read + file_path, Bash + command).
	let toolName;
	let toolInput;
	if (tool === "read") {
		const filePath = input.path || input.file_path || input.filePath;
		if (typeof filePath !== "string" || filePath === "") return { deny: false };
		toolName = "Read";
		toolInput = { file_path: filePath };
	} else if (tool === "bash") {
		const command = input.command;
		if (typeof command !== "string" || command === "") return { deny: false };
		toolName = "Bash";
		toolInput = { command };
	} else {
		return { deny: false };
	}

	const result = await runHook(
		options.scriptPath || scriptPathFrom(),
		{ tool_name: toolName, tool_input: toolInput, cwd },
		timeoutMsFrom(options),
	);

	const decision = result?.hookSpecificOutput?.permissionDecision;
	if (decision === "deny") {
		const reason = result.hookSpecificOutput.permissionDecisionReason;
		return {
			deny: true,
			reason:
				typeof reason === "string" && reason.length > 0
					? reason
					: `${toolName} blocked by trufflehog-guard.`,
		};
	}
	return { deny: false };
}
