import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { limitHistoryTurns } from "../../agents/pi-embedded-runner/history.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import {
  DEFAULT_RESET_TRIGGERS,
  deriveSessionMetaPatch,
  evaluateSessionFreshness,
  type GroupKeyResolution,
  loadSessionStore,
  resolveChannelResetConfig,
  resolveThreadFlag,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveGroupSessionKey,
  resolveSessionFilePath,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
  updateSessionStore,
} from "../../config/sessions.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};

function normalizeTurnLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized) || normalized < 1) return undefined;
  return normalized;
}

function resolveSlackThreadParentLimit(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): number | undefined {
  const slack = params.cfg.channels?.slack;
  if (!slack || typeof slack !== "object") return undefined;
  const accountId = params.accountId?.trim();
  const accounts =
    slack && typeof slack === "object" && "accounts" in slack ? slack.accounts : undefined;
  const account =
    accountId && accounts && typeof accounts === "object"
      ? ((accounts as Record<string, { thread?: { inheritParentLimit?: number } } | undefined>)[
          accountId
        ] ??
        (accounts as Record<string, { thread?: { inheritParentLimit?: number } } | undefined>)[
          accountId.toLowerCase()
        ])
      : undefined;
  return normalizeTurnLimit(
    account?.thread?.inheritParentLimit ??
      (slack as { thread?: { inheritParentLimit?: number } }).thread?.inheritParentLimit,
  );
}

function resolveSlackThreadInheritParent(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): boolean {
  const slack = params.cfg.channels?.slack;
  if (!slack || typeof slack !== "object") return false;
  const accountId = params.accountId?.trim();
  const accounts =
    slack && typeof slack === "object" && "accounts" in slack ? slack.accounts : undefined;
  const account =
    accountId && accounts && typeof accounts === "object"
      ? ((accounts as Record<string, { thread?: { inheritParent?: boolean } } | undefined>)[
          accountId
        ] ??
        (accounts as Record<string, { thread?: { inheritParent?: boolean } } | undefined>)[
          accountId.toLowerCase()
        ])
      : undefined;
  return Boolean(
    account?.thread?.inheritParent ??
    (slack as { thread?: { inheritParent?: boolean } }).thread?.inheritParent,
  );
}

function resolveSlackThreadIncludeToolResults(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): boolean {
  const slack = params.cfg.channels?.slack;
  if (!slack || typeof slack !== "object") return true;
  const accountId = params.accountId?.trim();
  const accounts =
    slack && typeof slack === "object" && "accounts" in slack ? slack.accounts : undefined;
  const account =
    accountId && accounts && typeof accounts === "object"
      ? ((
          accounts as Record<
            string,
            { thread?: { inheritParentIncludeToolResults?: boolean } } | undefined
          >
        )[accountId] ??
        (
          accounts as Record<
            string,
            { thread?: { inheritParentIncludeToolResults?: boolean } } | undefined
          >
        )[accountId.toLowerCase()])
      : undefined;
  const configured =
    account?.thread?.inheritParentIncludeToolResults ??
    (slack as { thread?: { inheritParentIncludeToolResults?: boolean } }).thread
      ?.inheritParentIncludeToolResults;
  return configured !== undefined ? Boolean(configured) : true;
}

const THREAD_SESSION_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):[^:]+)$/i;

function inferParentSessionKey(sessionKey?: string | null): string | undefined {
  const trimmed = sessionKey?.trim();
  if (!trimmed) return undefined;
  const match = THREAD_SESSION_SUFFIX_REGEX.exec(trimmed);
  const parentKey = match?.[1]?.trim();
  return parentKey || undefined;
}

function readSessionParentHeader(sessionFile: string): string | undefined {
  if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;
  const content = fs.readFileSync(sessionFile, "utf-8");
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex < 0) return undefined;
  const header = JSON.parse(lines[headerIndex] ?? "{}") as {
    type?: string;
    parentSession?: string;
  };
  if (header.type !== "session") return undefined;
  const parentSession = header.parentSession?.trim();
  return parentSession || undefined;
}

function setSessionParentHeader(params: { sessionFile: string; parentSessionFile: string }) {
  const { sessionFile, parentSessionFile } = params;
  const content = fs.readFileSync(sessionFile, "utf-8");
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex < 0) return;
  const header = JSON.parse(lines[headerIndex] ?? "{}") as { type?: string };
  if (header.type !== "session") return;
  const nextHeader = { ...header, parentSession: parentSessionFile };
  lines[headerIndex] = JSON.stringify(nextHeader);
  fs.writeFileSync(sessionFile, lines.join("\n"), "utf-8");
}

function persistSessionIfMissing(params: {
  manager: SessionManager;
  parentSessionFile?: string;
}): boolean {
  const sessionFile = params.manager.getSessionFile();
  if (!sessionFile) return false;
  if (fs.existsSync(sessionFile)) return true;
  const header = params.manager.getHeader();
  if (!header) return false;
  const headerWithParent = params.parentSessionFile
    ? { ...header, parentSession: params.parentSessionFile }
    : header;
  const entries = params.manager.getEntries();
  const content = `${[headerWithParent, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  fs.writeFileSync(sessionFile, content, "utf-8");
  return true;
}

function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
    return null;
  }
  try {
    const manager = SessionManager.open(parentSessionFile);
    const leafId = manager.getLeafId();
    if (leafId) {
      const sessionFile = manager.createBranchedSession(leafId) ?? manager.getSessionFile();
      const sessionId = manager.getSessionId();
      if (sessionFile && sessionId) {
        return { sessionId, sessionFile };
      }
    }
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(manager.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: manager.getCwd(),
      parentSession: parentSessionFile,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

function isPiMessage(value: unknown): value is { role: "user" | "assistant" | "toolResult" } {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

function stripAssistantToolCalls(
  message: Extract<AgentMessage, { role: "assistant" }>,
): Extract<AgentMessage, { role: "assistant" }> | null {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  const nextContent = content.filter((block) => {
    if (!block || typeof block !== "object") return true;
    const type = (block as { type?: unknown }).type;
    return type !== "toolCall" && type !== "toolUse" && type !== "functionCall";
  });
  if (nextContent.length === 0) return null;
  if (nextContent.length === content.length) return message;
  return { ...message, content: nextContent };
}

function filterParentMessages(params: {
  messages: AgentMessage[];
  includeToolResults: boolean;
}): AgentMessage[] {
  if (params.includeToolResults) return params.messages;
  const filtered: AgentMessage[] = [];
  for (const message of params.messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role === "toolResult") continue;
    if (role === "assistant") {
      const stripped = stripAssistantToolCalls(
        message as Extract<AgentMessage, { role: "assistant" }>,
      );
      if (stripped) filtered.push(stripped);
      continue;
    }
    if (role === "user") {
      filtered.push(message);
    }
  }
  return filtered;
}

function forkSessionFromParentWithLimit(params: {
  parentEntry: SessionEntry;
  limit?: number;
  includeToolResults?: boolean;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) return null;
  try {
    const parent = SessionManager.open(parentSessionFile);
    const parentContext = parent.buildSessionContext();
    const limitedMessages = limitHistoryTurns(parentContext.messages, params.limit);
    const filteredMessages = filterParentMessages({
      messages: limitedMessages,
      includeToolResults: params.includeToolResults ?? true,
    });

    const forked = SessionManager.create(parent.getCwd(), parent.getSessionDir());
    for (const message of filteredMessages) {
      if (!isPiMessage(message)) continue;
      forked.appendMessage(message);
    }
    const sessionFile = forked.getSessionFile();
    const sessionId = forked.getSessionId();
    if (!sessionFile || !sessionId) return null;
    persistSessionIfMissing({ manager: forked, parentSessionFile });
    setSessionParentHeader({ sessionFile, parentSessionFile });
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

function mergeSessionFromParent(params: {
  parentEntry: SessionEntry;
  childEntry: SessionEntry;
  limit?: number;
  includeToolResults?: boolean;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
  );
  const childSessionFile = resolveSessionFilePath(params.childEntry.sessionId, params.childEntry);
  if (
    !parentSessionFile ||
    !childSessionFile ||
    !fs.existsSync(parentSessionFile) ||
    !fs.existsSync(childSessionFile)
  ) {
    return null;
  }
  try {
    const parent = SessionManager.open(parentSessionFile);
    const child = SessionManager.open(childSessionFile);
    const parentContext = parent.buildSessionContext();
    const childContext = child.buildSessionContext();
    const limitedParent = params.limit
      ? limitHistoryTurns(parentContext.messages, params.limit)
      : parentContext.messages;
    const filteredParent = filterParentMessages({
      messages: limitedParent,
      includeToolResults: params.includeToolResults ?? true,
    });

    const merged = SessionManager.create(child.getCwd(), child.getSessionDir());
    for (const message of filteredParent) {
      if (!isPiMessage(message)) continue;
      merged.appendMessage(message);
    }
    for (const message of childContext.messages) {
      if (!isPiMessage(message)) continue;
      merged.appendMessage(message);
    }

    const sessionFile = merged.getSessionFile();
    const sessionId = merged.getSessionId();
    if (!sessionFile || !sessionId) return null;
    persistSessionIfMissing({ manager: merged, parentSessionFile });
    setSessionParentHeader({ sessionFile, parentSessionFile });
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const providerId = (ctx.Provider ?? ctx.Surface ?? "").trim().toLowerCase();
  const slackThreadInheritParent =
    providerId === "slack"
      ? resolveSlackThreadInheritParent({ cfg, accountId: ctx.AccountId ?? undefined })
      : false;
  const slackThreadParentLimit =
    providerId === "slack"
      ? resolveSlackThreadParentLimit({ cfg, accountId: ctx.AccountId ?? undefined })
      : undefined;
  const slackThreadIncludeToolResults =
    providerId === "slack"
      ? resolveSlackThreadIncludeToolResults({ cfg, accountId: ctx.AccountId ?? undefined })
      : true;

  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath);
  let sessionKey: string | undefined;
  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;
  let resetTriggered = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;
  let persistedReasoning: string | undefined;
  let persistedTtsAuto: TtsAutoMode | undefined;
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // to Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  // IMPORTANT: do NOT lowercase the entire command body.
  // Users often pass case-sensitive arguments (e.g. filesystem paths on Linux).
  // Command parsing downstream lowercases only the command token for matching.
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();

  // Use CommandBody/RawBody for reset trigger matching (clean message without structural context).
  const rawBody = commandSource;
  const trimmedBody = rawBody.trim();
  const resetAuthorized = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  }).isAuthorizedSender;
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // web inbox before we get here. They prevented reset triggers like "/new"
  // from matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;

  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = trimmedBody.toLowerCase();
  const strippedForResetLower = strippedForReset.toLowerCase();

  for (const trigger of resetTriggers) {
    if (!trigger) {
      continue;
    }
    if (!resetAuthorized) {
      break;
    }
    const triggerLower = trigger.toLowerCase();
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      trimmedBodyLower.startsWith(triggerPrefixLower) ||
      strippedForResetLower.startsWith(triggerPrefixLower)
    ) {
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      break;
    }
  }

  sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  const entry = sessionStore[sessionKey];
  const derivedParentSessionKey =
    slackThreadInheritParent && !ctx.ParentSessionKey
      ? inferParentSessionKey(sessionKey)
      : undefined;
  const parentSessionKey = ctx.ParentSessionKey?.trim() || derivedParentSessionKey;
  const previousSessionEntry = resetTriggered && entry ? { ...entry } : undefined;
  const now = Date.now();
  const isThread = resolveThreadFlag({
    sessionKey,
    messageThreadId: ctx.MessageThreadId,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
    parentSessionKey: ctx.ParentSessionKey,
  });
  const resetType = resolveSessionResetType({ sessionKey, isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const freshEntry = entry
    ? evaluateSessionFreshness({ updatedAt: entry.updatedAt, now, policy: resetPolicy }).fresh
    : false;

  if (!isNewSession && freshEntry) {
    sessionId = entry.sessionId;
    systemSent = entry.systemSent ?? false;
    abortedLastRun = entry.abortedLastRun ?? false;
    persistedThinking = entry.thinkingLevel;
    persistedVerbose = entry.verboseLevel;
    persistedReasoning = entry.reasoningLevel;
    persistedTtsAuto = entry.ttsAuto;
    persistedModelOverride = entry.modelOverride;
    persistedProviderOverride = entry.providerOverride;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const lastChannelRaw = (ctx.OriginatingChannel as string | undefined) || baseEntry?.lastChannel;
  const lastToRaw = ctx.OriginatingTo || ctx.To || baseEntry?.lastTo;
  const lastAccountIdRaw = ctx.AccountId || baseEntry?.lastAccountId;
  const lastThreadIdRaw = ctx.MessageThreadId || baseEntry?.lastThreadId;
  const deliveryFields = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: lastChannelRaw,
      to: lastToRaw,
      accountId: lastAccountIdRaw,
      threadId: lastThreadIdRaw,
    },
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
  const lastThreadId = deliveryFields.lastThreadId ?? lastThreadIdRaw;
  sessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    systemSent,
    abortedLastRun,
    // Persist previously stored thinking/verbose levels when present.
    thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
    verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    reasoningLevel: persistedReasoning ?? baseEntry?.reasoningLevel,
    ttsAuto: persistedTtsAuto ?? baseEntry?.ttsAuto,
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: baseEntry?.displayName,
    chatType: baseEntry?.chatType,
    channel: baseEntry?.channel,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    deliveryContext: deliveryFields.deliveryContext,
    // Track originating channel for subagent announce routing.
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = ctx.ThreadLabel?.trim();
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  if (
    isNewSession &&
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey]
  ) {
    const parentEntry = sessionStore[parentSessionKey];
    const forked =
      parentEntry && (slackThreadParentLimit || !slackThreadIncludeToolResults)
        ? forkSessionFromParentWithLimit({
            parentEntry,
            limit: slackThreadParentLimit,
            includeToolResults: slackThreadIncludeToolResults,
          })
        : forkSessionFromParent({
            parentEntry,
          });
    if (forked) {
      sessionId = forked.sessionId;
      sessionEntry.sessionId = forked.sessionId;
      sessionEntry.sessionFile = forked.sessionFile;
    }
  }
  if (!isNewSession && parentSessionKey && parentSessionKey !== sessionKey) {
    const parentEntry = sessionStore[parentSessionKey];
    const sessionFile = resolveSessionFilePath(sessionEntry.sessionId, sessionEntry);
    if (parentEntry && sessionFile && !readSessionParentHeader(sessionFile)) {
      const merged = mergeSessionFromParent({
        parentEntry,
        childEntry: sessionEntry,
        limit: slackThreadParentLimit,
        includeToolResults: slackThreadIncludeToolResults,
      });
      if (merged) {
        sessionId = merged.sessionId;
        sessionEntry.sessionId = merged.sessionId;
        sessionEntry.sessionFile = merged.sessionFile;
      }
    }
  }
  if (!sessionEntry.sessionFile) {
    sessionEntry.sessionFile = resolveSessionTranscriptPath(
      sessionEntry.sessionId,
      agentId,
      ctx.MessageThreadId,
    );
  }
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(storePath, (store) => {
    // Preserve per-session overrides while resetting compaction state on /new.
    store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
  });

  const sessionCtx: TemplateContext = {
    ...ctx,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: formatInboundBodyWithSenderMeta({
      ctx,
      body: normalizeInboundTextNewlines(
        bodyStripped ??
          ctx.BodyForAgent ??
          ctx.Body ??
          ctx.CommandBody ??
          ctx.RawBody ??
          ctx.BodyForCommands ??
          "",
      ),
    }),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionId ?? crypto.randomUUID(),
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
  };
}
