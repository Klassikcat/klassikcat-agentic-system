/**
 * trufflehog-guard for pi
 *
 * Blocks `read` tool calls — and `bash` commands that would print a file's
 * contents (`cat`, `head`, `grep <file>`, `< file`, ...) — when the target file
 * appears to contain credentials, by running the shared
 * `hooks-opencode/trufflehog-guard/trufflehog-guard.py` core (the same script
 * the OpenCode plugin and Claude Code PreToolUse hooks use).
 *
 * Install: symlink or copy this directory into ~/.pi/agent/extensions/
 * (auto-discovered as `trufflehog-guard/index.ts`), then restart pi or run
 * /reload. See README.md for details.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkToolCall } from "./guard.mjs";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		if (tool !== "read" && tool !== "bash") return undefined;
		if (typeof event.input !== "object" || event.input === null) return undefined;

		const { deny, reason } = await checkToolCall(tool, event.input, ctx.cwd);
		if (deny) {
			return { block: true, reason };
		}
		return undefined;
	});
}
