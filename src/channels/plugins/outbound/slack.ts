import { sendMessageSlack } from "../../../slack/send.js";
import { logVerbose } from "../../../globals.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Use threadId fallback so routed tool notifications stay in the Slack thread.
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    const result = await send(to, text, {
      threadTs,
      accountId: accountId ?? undefined,
    });
    return { channel: "slack", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Use threadId fallback so routed tool notifications stay in the Slack thread.
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    const result = await send(to, text, {
      mediaUrl,
      threadTs,
      accountId: accountId ?? undefined,
    });
    return { channel: "slack", ...result };
  },
  sendPayload: async ({ to, text, accountId, deps, replyToId, threadId, payload }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
    // Extract Slack-specific blocks from channelData
    const slackData = payload?.channelData?.slack as { blocks?: unknown[] } | undefined;
    const blocks = slackData?.blocks;
    logVerbose(
      `slack outbound sendPayload: to=${to}, hasChannelData=${!!payload?.channelData}, hasSlackData=${!!slackData}, blocksCount=${blocks?.length ?? 0}`,
    );
    const result = await send(to, text, {
      threadTs,
      accountId: accountId ?? undefined,
      blocks,
    });
    return { channel: "slack", ...result };
  },
};
