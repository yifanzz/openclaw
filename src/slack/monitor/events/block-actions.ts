import type { SlackMonitorContext } from "../context.js";

const EXEC_APPROVAL_ACTIONS = new Set(["exec_approve_once", "exec_approve_always", "exec_deny"]);

function mapActionToDecision(actionId: string): string | null {
  switch (actionId) {
    case "exec_approve_once":
      return "allow-once";
    case "exec_approve_always":
      return "allow-always";
    case "exec_deny":
      return "deny";
    default:
      return null;
  }
}

export function registerSlackBlockActions(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  ctx.app.action(/^exec_/, async ({ action, ack, body, client }) => {
    await ack();

    // Type guard for button actions
    if (!("action_id" in action) || !("value" in action)) return;

    const actionId = action.action_id;
    const approvalId = action.value;

    if (!EXEC_APPROVAL_ACTIONS.has(actionId) || !approvalId) return;

    const decision = mapActionToDecision(actionId);
    if (!decision) return;

    // Get user info for resolvedBy
    const userId = body.user?.id;
    const user = body.user as { name?: string; username?: string } | undefined;
    const userName = user?.name ?? user?.username;
    const resolvedBy = userName
      ? `<@${userId}> (${userName})`
      : userId
        ? `<@${userId}>`
        : undefined;

    // Call gateway to resolve the approval
    try {
      const resolved = await ctx.resolveExecApproval?.(approvalId, decision, resolvedBy);

      // Update the message to show the result
      if ("message" in body && body.message && "channel" in body && body.channel) {
        const channelId = body.channel.id;
        const messageTs = body.message.ts;
        const decisionText =
          decision === "allow-once"
            ? "✅ Allowed once"
            : decision === "allow-always"
              ? "🔐 Always allowed"
              : "❌ Denied";
        const byText = resolvedBy ? ` by ${resolvedBy}` : "";

        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `${decisionText}${byText}. ID: ${approvalId.slice(0, 8)}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${decisionText}${byText}\nID: \`${approvalId.slice(0, 8)}\``,
              },
            },
          ],
        });
      }

      ctx.log?.(
        `exec approval ${approvalId.slice(0, 8)}: ${decision} by ${resolvedBy ?? "unknown"}`,
      );
    } catch (err) {
      ctx.error?.(`exec approval ${approvalId.slice(0, 8)} failed: ${String(err)}`);
    }
  });
}
