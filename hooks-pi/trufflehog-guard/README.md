# trufflehog guard for pi

pi extension that blocks `read` tool calls — and `bash` commands that would print a file's contents — when the target file appears to contain credentials.

Thin wrapper around the shared [`trufflehog-guard.py`](../../hooks-opencode/trufflehog-guard/trufflehog-guard.py) core, the same script the OpenCode plugin and the Claude Code `PreToolUse` hooks run. Detection logic lives in one place; only the integration differs per agent.

## Behavior

- Fires on pi's `tool_call` event for `read` and `bash` only (other tools pass through untouched).
- `read`: scans `input.path`.
- `bash`: parses `input.command` and scans the files that content-printing commands (`cat`, `head`, `tail`, `less`, `grep`, `xxd`, `base64`, `jq`, ...) or an input redirect (`< file`) would expose. Write/list/move-only commands are left alone.
- Blocks well-known sensitive local paths (`~/.ssh`, `~/.aws/credentials`, `~/.kube/config`, ...) even without trufflehog installed.
- Returns `{ block: true, reason }` with detector names only — never prints raw findings or secret values.
- Fails open: if `python3` is missing, the script path is wrong, or the guard hangs (killed after 20 s), the tool call is allowed.

See the core's [README](../../hooks-opencode/trufflehog-guard/README.md) for full detection rules and Bash parsing limitations.

## Requirements

- `python3`
- `trufflehog` on `PATH`, or at `/home/linuxbrew/.linuxbrew/bin/trufflehog` (optional — well-known paths are still blocked without it)

## Install

Symlink (recommended — tracks this repo) or copy this directory into pi's global extensions directory:

```bash
# symlink (stays in sync with the repo)
ln -s ~/Projects/Personal/opencode-hooks/hooks-pi/trufflehog-guard ~/.pi/agent/extensions/trufflehog-guard

# or copy
mkdir -p ~/.pi/agent/extensions/trufflehog-guard
cp index.ts guard.mjs ~/.pi/agent/extensions/trufflehog-guard/
```

Restart pi or run `/reload`. pi auto-discovers `extensions/*/index.ts`.

### Options

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PI_TRUFFLEHOG_GUARD_SCRIPT` | `../../hooks-opencode/trufflehog-guard/trufflehog-guard.py` (resolved relative to `guard.mjs`, symlinks followed) | Path to the shared core script |
| `PI_TRUFFLEHOG_GUARD_TIMEOUT_MS` | `20000` | Kill the guard subprocess after this long (fail open) |

## Verify

```bash
cd ~/Projects/Personal/opencode-hooks/hooks-pi/trufflehog-guard
npm run check          # syntax + smoke test (safe read, sensitive read/bash, fail-open)

# end-to-end
pi -p --no-session "read /home/<you>/.ssh/id_ed25519"   # expect the read to be blocked
```
