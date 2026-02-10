import type { WebClient } from "@slack/web-api";
import { logVerbose } from "../../../globals.js";

const MIN_GAP_MS = 60_000;
const MAX_MESSAGES = 20;
const MAX_MSG_CHARS = 500;

/**
 * Fetch recent channel messages that occurred between the session's last activity
 * and the current inbound message. Returns formatted context string or empty string.
 */
export async function fetchRecentChannelContext(params: {
  channel: string;
  previousTimestampMs: number | undefined;
  currentMessageTs: string;
  client: WebClient;
}): Promise<string> {
  const { channel, previousTimestampMs, currentMessageTs, client } = params;

  if (!previousTimestampMs) {
    return "";
  }

  const currentMs = Number(currentMessageTs) * 1000;
  if (currentMs - previousTimestampMs < MIN_GAP_MS) {
    return "";
  }

  try {
    const oldest = String(previousTimestampMs / 1000);
    const result = await client.conversations.history({
      channel,
      oldest,
      latest: currentMessageTs,
      inclusive: false,
      limit: MAX_MESSAGES,
    });

    const messages = result.messages;
    if (!messages || messages.length === 0) {
      return "";
    }

    // Filter out the current inbound message
    const contextMessages = messages.filter((m) => m.ts !== currentMessageTs).toReversed(); // oldest first

    if (contextMessages.length === 0) {
      return "";
    }

    const lines = contextMessages.map((m) => {
      const sender = m.username ?? m.user ?? m.bot_id ?? "unknown";
      const ts = m.ts
        ? new Date(Number(m.ts) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
        : "";
      let text = (m.text ?? "").trim();
      if (text.length > MAX_MSG_CHARS) {
        text = text.slice(0, MAX_MSG_CHARS) + "…";
      }
      return `[Slack ${sender} ${ts}] ${text}`;
    });

    logVerbose(
      `slack: channel catchup for ${channel}: ${contextMessages.length} messages since last session activity`,
    );

    return `[Recent channel activity since last session message:]\n${lines.join("\n")}\n`;
  } catch (err) {
    logVerbose(`slack: channel catchup failed for ${channel}: ${String(err)}`);
    return "";
  }
}
