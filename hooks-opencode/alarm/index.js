const DEFAULT_TIMEOUT_MS = 10_000;
const sessionState = new Map();
const notifiedQuestions = new Set();

function isTruthy(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function sessionIDFrom(event) {
  return event?.properties?.sessionID ?? event?.data?.sessionID;
}

function eventPayload(event) {
  return event?.properties ?? event?.data ?? {};
}

function errorName(error) {
  return error?.name ?? error?.type ?? error?.data?.name ?? "UnknownError";
}

function errorMessage(error) {
  return error?.data?.message ?? error?.message ?? "Unknown error";
}

function isAbortError(error) {
  const name = errorName(error).toLowerCase();
  const message = errorMessage(error).toLowerCase();
  return name.includes("abort") || message.includes("abort") || message.includes("cancel");
}

function isSubagentSession(info) {
  return Boolean(info?.parentID);
}

function displayTitle(info, sessionID) {
  return info?.title || info?.path || sessionID || "unknown session";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatMessage(kind, details) {
  const icon = kind === "completed" ? "✅" : kind === "aborted" ? "⛔" : "❌";
  const label = kind === "completed" ? "OpenCode work completed" : kind === "aborted" ? "OpenCode work aborted" : "OpenCode work failed";
  const lines = [`${icon} <b>${label}</b>`];

  if (details.title) lines.push(`Session: <code>${escapeHtml(details.title)}</code>`);
  if (details.sessionID) lines.push(`ID: <code>${escapeHtml(details.sessionID)}</code>`);
  if (details.agent) lines.push(`Agent: <code>${escapeHtml(details.agent)}</code>`);
  if (details.directory) lines.push(`Dir: <code>${escapeHtml(details.directory)}</code>`);
  if (details.error) lines.push(`Error: <code>${escapeHtml(details.error)}</code>`);
  if (details.finish) lines.push(`Finish: <code>${escapeHtml(details.finish)}</code>`);

  return lines.join("\n");
}

function formatQuestionMessage(details) {
  const lines = ["❓ <b>OpenCode question waiting</b>"];
  if (details.question) lines.push(`Question: <code>${escapeHtml(details.question)}</code>`);
  if (details.options?.length) lines.push(`Options: <code>${escapeHtml(details.options.join(", "))}</code>`);
  if (details.id) lines.push(`ID: <code>${escapeHtml(details.id)}</code>`);
  if (details.directory) lines.push(`Dir: <code>${escapeHtml(details.directory)}</code>`);
  return lines.join("\n");
}

export async function postTelegram({ botToken, chatID, topicID, text, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const body = {
      chat_id: chatID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (topicID) body.message_thread_id = Number(topicID);

    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: ${response.status} ${response.statusText} ${responseText}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }
}

function markStarted(sessionID, agent) {
  if (!sessionID) return;
  const current = sessionState.get(sessionID) ?? {};
  sessionState.set(sessionID, { ...current, active: true, notified: false, agent });
}

function resetNotified(sessionID) {
  if (!sessionID) return;
  const current = sessionState.get(sessionID) ?? {};
  sessionState.set(sessionID, { ...current, notified: false });
}

function shouldIgnore(info, notifySubagents) {
  return !notifySubagents && isSubagentSession(info);
}

function resolveConfig(options = {}) {
  return {
    enabled: isTruthy(options.enabled ?? process.env.OPENCODE_TELEGRAM_ENABLED),
    botToken: String(options.botToken || process.env.OPENCODE_TELEGRAM_BOT_TOKEN || ""),
    chatID: String(options.chatID || options.chatId || process.env.OPENCODE_TELEGRAM_CHAT_ID || ""),
    topicID: options.topicID || process.env.OPENCODE_TELEGRAM_TOPIC_ID,
    notifySubagents: isTruthy(options.notifySubagents ?? process.env.OPENCODE_TELEGRAM_NOTIFY_SUBAGENTS),
    completionAgents: String(options.completionAgents || process.env.OPENCODE_TELEGRAM_COMPLETION_AGENTS || "prometheus,atlas")
      .split(",").map(a => a.trim().toLowerCase()).filter(Boolean),
    fetchImpl: options.fetchImpl,
  };
}

// Shared session-event state machine used by both the V1 `event` hook and the
// V2 event subscription. The `notified` flag dedupes so overlapping event
// names (for example session.idle and session.status=idle) never double-notify.
function makeHandlers(config, directory) {
  const { botToken, chatID, topicID, notifySubagents, completionAgents } = config;
  const fetchImpl = config.fetchImpl || fetch;

  function matchesCompletionAgent(agent) {
    if (!agent) return false;
    const lower = agent.toLowerCase();
    return completionAgents.some(name => lower.startsWith(name) || lower.includes(name));
  }

  async function notify(kind, details) {
    if (!details.sessionID) return;

    const current = sessionState.get(details.sessionID) ?? {};
    if (current.notified) return;
    sessionState.set(details.sessionID, { ...current, notified: true, active: false });

    try {
      await postTelegram({ botToken, chatID, topicID, text: formatMessage(kind, details), fetchImpl });
    } catch (error) {
      console.warn(`[opencode-alarm-hook] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function notifyQuestion(details) {
    if (!details.id || notifiedQuestions.has(details.id)) return;
    notifiedQuestions.add(details.id);

    try {
      await postTelegram({ botToken, chatID, topicID, text: formatQuestionMessage(details), fetchImpl });
    } catch (error) {
      console.warn(`[opencode-alarm-hook] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleFailure(sessionID, error) {
    const info = sessionState.get(sessionID)?.info;
    if (shouldIgnore(info, notifySubagents)) return;
    await notify(isAbortError(error) ? "aborted" : "failed", {
      sessionID,
      title: displayTitle(info, sessionID),
      agent: info?.agent,
      directory,
      error: errorMessage(error),
    });
  }

  async function handleCompletion(sessionID, finish) {
    const state = sessionState.get(sessionID);
    const info = state?.info;
    if (shouldIgnore(info, notifySubagents)) return;
    if (finish && (String(finish).toLowerCase().includes("abort") || String(finish).toLowerCase().includes("cancel"))) {
      await notify("aborted", {
        sessionID,
        title: displayTitle(info, sessionID),
        agent: info?.agent,
        directory,
        finish,
      });
      return;
    }
    const agent = state?.agent;
    if (matchesCompletionAgent(agent)) {
      await notify("completed", {
        sessionID,
        title: displayTitle(info, sessionID),
        agent,
        directory,
      });
    }
  }

  // Handles both V1 event names and the V2 event stream.
  async function handleEvent(event) {
    const payload = eventPayload(event);
    const sessionID = sessionIDFrom(event);

    if (event.type === "permission.asked" || event.type === "question.asked") {
      // V2 surfaces permission prompts; V1 used question.asked.
      const isPermission = event.type === "permission.asked";
      const firstQuestion = payload.questions?.[0];
      await notifyQuestion({
        id: payload.id ?? event.id,
        question: isPermission
          ? [payload.permission, ...(payload.patterns ?? [])].filter(Boolean).join(" · ")
          : firstQuestion?.question,
        options: isPermission ? undefined : firstQuestion?.options?.map((option) => option?.label).filter(Boolean),
        directory,
      });
      return;
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      const info = payload.info;
      if (info?.id && !shouldIgnore(info, notifySubagents)) {
        const current = sessionState.get(info.id) ?? {};
        sessionState.set(info.id, { ...current, info, agent: info.agent ?? current.agent });
      }
      return;
    }

    if (event.type === "session.deleted") {
      sessionState.delete(payload.info?.id ?? sessionID);
      return;
    }

    if (event.type === "session.next.prompted" || event.type === "session.next.synthetic") {
      resetNotified(sessionID);
      return;
    }

    // V2 signals run state through session.status; busy resets the notified flag.
    if (event.type === "session.status") {
      const status = payload.status?.type;
      if (status === "busy") {
        resetNotified(sessionID);
        markStarted(sessionID, sessionState.get(sessionID)?.agent);
      } else if (status === "idle") {
        await handleCompletion(sessionID);
      }
      return;
    }

    if (event.type === "session.next.step.started") {
      if (sessionID) markStarted(sessionID, payload.agent);
      return;
    }

    if (event.type === "session.next.step.failed") {
      await handleFailure(sessionID, payload.error);
      return;
    }

    if (event.type === "session.next.step.ended") {
      await handleCompletion(sessionID, payload.finish);
      return;
    }

    if (event.type === "session.error") {
      await handleFailure(sessionID, payload.error);
      return;
    }

    if (event.type === "session.idle") {
      await handleCompletion(sessionID);
    }
  }

  return { handleEvent };
}

// V1 (OpenCode 1.x) plugin: called as server(input, options) through the
// default export below, or directly as the named `plugin` export by older
// loaders and the smoke test.
export const plugin = async (ctx, options = {}) => {
  const config = resolveConfig(options);
  // Silent by default so ad-hoc opencode launches skip quietly; only opencode-server.service sets this flag. The token warn below still fires for an opted-in-but-misconfigured server.
  if (!config.enabled) {
    return {};
  }

  if (!config.botToken || !config.chatID) {
    console.warn("[opencode-alarm-hook] OPENCODE_TELEGRAM_BOT_TOKEN or OPENCODE_TELEGRAM_CHAT_ID is missing; Telegram notifications disabled.");
    return {};
  }

  const { handleEvent } = makeHandlers(config, ctx.directory);
  return {
    event: async ({ event }) => {
      await handleEvent(event);
    },
  };
};

// Dual-format default export:
//   - OpenCode 1.x detects the object default and calls server(input, options).
//   - OpenCode 2 reads id and calls setup(ctx) with plugin options on ctx.options.
export default {
  id: "opencode-alarm-hook",

  server: plugin,

  async setup(ctx) {
    const config = resolveConfig({ ...ctx.options });
    if (!config.enabled) return;
    if (!config.botToken || !config.chatID) {
      console.warn("[opencode-alarm-hook] OPENCODE_TELEGRAM_BOT_TOKEN or OPENCODE_TELEGRAM_CHAT_ID is missing; Telegram notifications disabled.");
      return;
    }

    const directory = ctx.location.directory;
    const { handleEvent } = makeHandlers(config, directory);
    const controller = new AbortController();

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await handleEvent(event);
        }
      } catch (error) {
        if (!isAbortError(error)) {
          console.warn(`[opencode-alarm-hook] event stream ended: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();

    return () => controller.abort();
  },
};

export const server = plugin;
