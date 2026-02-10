import type { App } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { readSessionUpdatedAt } from "../../../config/sessions.js";
import { createSlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";

vi.mock("../../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../../config/sessions.js")>(
    "../../../config/sessions.js",
  );
  return {
    ...actual,
    readSessionUpdatedAt: vi.fn(),
  };
});

const readSessionUpdatedAtMock = vi.mocked(readSessionUpdatedAt);

describe("slack prepareSlackMessage thread catchup", () => {
  beforeEach(() => {
    readSessionUpdatedAtMock.mockReset();
  });

  it("uses thread catchup when thread history scope is thread", async () => {
    const threadTs = "900.000";
    const currentTs = "1000.000";
    const previousTimestampMs = 880_000;

    const replies = vi.fn().mockImplementation((params: { limit?: number }) => {
      if (params.limit === 1) {
        return {
          messages: [
            {
              text: "thread root",
              user: "U2",
              ts: threadTs,
            },
          ],
        };
      }
      return {
        messages: [
          { text: "missed 1", user: "U3", ts: "950.000" },
          { text: "missed 2", bot_id: "B2", ts: "970.000" },
          { text: "current", user: "U1", ts: currentTs },
        ],
      };
    });
    const history = vi.fn().mockResolvedValue({ messages: [] });

    const slackCtx = createSlackMonitorContext({
      cfg: {
        channels: { slack: { enabled: true } },
        session: { store: "/tmp/openclaw-test-sessions.json" },
      } as OpenClawConfig,
      accountId: "default",
      botToken: "token",
      app: { client: { conversations: { replies, history } } } as App,
      runtime: {} as RuntimeEnv,
      botUserId: "B1",
      teamId: "T1",
      apiAppId: "A1",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupDmEnabled: true,
      groupDmChannels: [],
      defaultRequireMention: false,
      groupPolicy: "open",
      useAccessGroups: false,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textLimit: 4000,
      ackReactionScope: "group-mentions",
      mediaMaxBytes: 1024,
      removeAckAfterReply: false,
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    slackCtx.resolveUserName = async () => ({ name: "Alice" }) as any;
    slackCtx.resolveChannelName = async () => ({ name: "general", type: "channel" });

    const account: ResolvedSlackAccount = {
      accountId: "default",
      enabled: true,
      botTokenSource: "config",
      appTokenSource: "config",
      config: {},
    };

    const message: SlackMessageEvent = {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "hello",
      ts: currentTs,
      thread_ts: threadTs,
      parent_user_id: "U2",
    } as SlackMessageEvent;

    readSessionUpdatedAtMock.mockReturnValue(previousTimestampMs);

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(history).not.toHaveBeenCalled();
    expect(replies).toHaveBeenCalled();

    const catchupCall = replies.mock.calls.find((call) => call[0]?.limit === 20);
    expect(catchupCall?.[0]).toMatchObject({
      channel: "C123",
      ts: threadTs,
      oldest: String(previousTimestampMs / 1000),
      latest: currentTs,
      inclusive: false,
      limit: 20,
    });

    expect(readSessionUpdatedAtMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: prepared!.ctxPayload.SessionKey }),
    );

    expect(prepared!.ctxPayload.BodyForAgent).toContain("Recent thread activity");
    expect(prepared!.ctxPayload.BodyForAgent).toContain("missed 1");
  });
});
