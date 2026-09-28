import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkToolCall } from "../guard.mjs";

const tempDir = await mkdtemp(path.join(tmpdir(), "pi-trufflehog-guard-"));

const deny = (result) => result.deny === true;
const allow = (result) => result.deny === false;

try {
	const safeFile = path.join(tempDir, "safe.txt");
	await writeFile(safeFile, "safe smoke test content\n", "utf8");

	// read: safe file allowed
	const readSafe = await checkToolCall("read", { path: safeFile }, tempDir);
	if (!allow(readSafe)) throw new Error(`safe read should be allowed: ${JSON.stringify(readSafe)}`);

	// read: unknown tool ignored
	const unknownTool = await checkToolCall("edit", { path: safeFile }, tempDir);
	if (!allow(unknownTool)) throw new Error("unknown tool should be ignored");

	// read: well-known sensitive path denied
	const readSensitive = await checkToolCall(
		"read",
		{ path: path.join(process.env.HOME || "", ".ssh", "nonexistent-private-key") },
		tempDir,
	);
	if (!deny(readSensitive) || !String(readSensitive.reason).includes("blocked")) {
		throw new Error(`sensitive read should be denied: ${JSON.stringify(readSensitive)}`);
	}

	// bash: safe command allowed
	const bashSafe = await checkToolCall("bash", { command: `grep pattern ${safeFile}` }, tempDir);
	if (!allow(bashSafe)) throw new Error(`safe bash should be allowed: ${JSON.stringify(bashSafe)}`);

	// bash: content-printing command on a sensitive path denied
	const bashSensitive = await checkToolCall(
		"bash",
		{ command: `cat ${path.join(process.env.HOME || "", ".ssh", "id_rsa")}` },
		tempDir,
	);
	if (!deny(bashSensitive) || !String(bashSensitive.reason).includes("blocked")) {
		throw new Error(`sensitive bash read should be denied: ${JSON.stringify(bashSensitive)}`);
	}

	// bash: write-only command on a sensitive path allowed (output redirect is not a read)
	const bashWrite = await checkToolCall(
		"bash",
		{ command: `echo key > ${path.join(tempDir, "out.txt")}` },
		tempDir,
	);
	if (!allow(bashWrite)) throw new Error(`write redirect should be allowed: ${JSON.stringify(bashWrite)}`);

	// missing script path fails open
	const failOpen = await checkToolCall("read", { path: safeFile }, tempDir, {
		scriptPath: "/nonexistent/trufflehog-guard.py",
	});
	if (!allow(failOpen)) throw new Error("missing script should fail open");

	console.log("pi trufflehog guard smoke test passed");
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
