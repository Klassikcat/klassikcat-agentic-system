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

function markStarted(sessionID) {
  if (!sessionID) return;
  const current = sessionState.get(sessionID) ?? {};
  sessionState.set(sessionID, { ...current, active: true, notified: false });
}

function shouldIgnore(info, notifySubagents) {
  return !notifySubagents && isSubagentSession(info);
}

export const plugin = async (ctx, options = {}) => {
  const botToken = String(options.botToken || process.env.OPENCODE_TELEGRAM_BOT_TOKEN || "");
  const chatID = String(options.chatID || options.chatId || process.env.OPENCODE_TELEGRAM_CHAT_ID || "");
  const topicID = options.topicID || process.env.OPENCODE_TELEGRAM_TOPIC_ID;
  const notifySubagents = isTruthy(options.notifySubagents ?? process.env.OPENCODE_TELEGRAM_NOTIFY_SUBAGENTS);
  const fetchImpl = options.fetchImpl || fetch;

  if (!botToken || !chatID) {
    console.warn("[opencode-alarm-hook] OPENCODE_TELEGRAM_BOT_TOKEN or OPENCODE_TELEGRAM_CHAT_ID is missing; Telegram notifications disabled.");
    return {};
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

  return {
    event: async ({ event }) => {
      const payload = eventPayload(event);
      const sessionID = sessionIDFrom(event);

      if (event.type === "question.asked") {
        const firstQuestion = payload.questions?.[0];
        await notifyQuestion({
          id: payload.id ?? event.id,
          question: firstQuestion?.question,
          options: firstQuestion?.options?.map((option) => option?.label).filter(Boolean),
          directory: ctx.directory,
        });
        return;
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        const info = payload.info;
        if (info?.id && !shouldIgnore(info, notifySubagents)) {
          const current = sessionState.get(info.id) ?? {};
          sessionState.set(info.id, { ...current, info });
        }
        return;
      }

      if (event.type === "session.deleted") {
        sessionState.delete(payload.info?.id ?? sessionID);
        return;
      }

      if (event.type === "session.next.step.started") {
        if (sessionID) markStarted(sessionID);
        return;
      }

      if (event.type === "session.next.step.failed") {
        const info = sessionState.get(sessionID)?.info;
        if (shouldIgnore(info, notifySubagents)) return;
        const error = payload.error;
        await notify(isAbortError(error) ? "aborted" : "failed", {
          sessionID,
          title: displayTitle(info, sessionID),
          agent: info?.agent,
          directory: ctx.directory,
          error: errorMessage(error),
        });
        return;
      }

      if (event.type === "session.next.step.ended") {
        const finish = String(payload.finish ?? "").toLowerCase();
        if (finish.includes("abort") || finish.includes("cancel")) {
          const info = sessionState.get(sessionID)?.info;
          if (shouldIgnore(info, notifySubagents)) return;
          await notify("aborted", {
            sessionID,
            title: displayTitle(info, sessionID),
            agent: info?.agent,
            directory: ctx.directory,
            finish: payload.finish,
          });
        }
        return;
      }

      if (event.type === "session.error") {
        const error = payload.error;
        const info = sessionState.get(sessionID)?.info;
        if (shouldIgnore(info, notifySubagents)) return;
        await notify(isAbortError(error) ? "aborted" : "failed", {
          sessionID,
          title: displayTitle(info, sessionID),
          agent: info?.agent,
          directory: ctx.directory,
          error: errorMessage(error),
        });
        return;
      }

      if (event.type === "session.idle") {
        const info = sessionState.get(sessionID)?.info;
        const current = sessionState.get(sessionID);
        if (shouldIgnore(info, notifySubagents) || !current?.active) return;
        await notify("completed", {
          sessionID,
          title: displayTitle(info, sessionID),
          agent: info?.agent,
          directory: ctx.directory,
        });
      }
    },
  };
};

export const server = plugin;

export default plugin;
