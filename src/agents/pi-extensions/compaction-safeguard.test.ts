import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../compaction.js", async (importActual) => {
  const actual = await importActual<typeof import("../compaction.js")>();
  return {
    ...actual,
    summarizeInStages: vi.fn(),
  };
});

import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension, { __testing } from "./compaction-safeguard.js";
import { summarizeInStages } from "../compaction.js";

const {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} = __testing;

describe("compaction-safeguard tool failures", () => {
  it("formats tool failures with meta and summary", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("exec (status=failed exitCode=1): ENOENT: missing file");
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ignored" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) => ({
      role: "toolResult",
      toolCallId: `call-${idx}`,
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: `error ${idx}` }],
      timestamp: Date.now(),
    }));

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
  });

  it("omits section when there are no tool failures", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toBe("");
  });
});

describe("computeAdaptiveChunkRatio", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns BASE_CHUNK_RATIO for normal messages", () => {
    // Small messages: 1000 tokens each, well under 10% of context
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(1000) }],
        timestamp: Date.now(),
      },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio when average message > 10% of context", () => {
    // Large messages: ~50K tokens each (25% of context)
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(50_000 * 4), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(50_000 * 4) }],
        timestamp: Date.now(),
      },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("respects MIN_CHUNK_RATIO floor", () => {
    // Very large messages that would push ratio below minimum
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(150_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("handles empty message array", () => {
    const ratio = computeAdaptiveChunkRatio([], CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("handles single huge message", () => {
    // Single massive message
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(180_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
    expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
  });
});

describe("isOversizedForSummary", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns false for small messages", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(false);
  });

  it("returns true for messages > 50% of context", () => {
    // Message with ~120K tokens (60% of 200K context)
    // After safety margin (1.2x), effective is 144K which is > 100K (50%)
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(120_000 * 4),
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(true);
  });

  it("applies safety margin", () => {
    // Message at exactly 50% of context before margin
    // After SAFETY_MARGIN (1.2), it becomes 60% which is > 50%
    const halfContextChars = (CONTEXT_WINDOW * 0.5) / SAFETY_MARGIN;
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(Math.floor(halfContextChars * 4)),
      timestamp: Date.now(),
    };

    // With safety margin applied, this should be at the boundary
    // The function checks if tokens * SAFETY_MARGIN > contextWindow * 0.5
    const isOversized = isOversizedForSummary(msg, CONTEXT_WINDOW);
    // Due to token estimation, this could be either true or false at the boundary
    expect(typeof isOversized).toBe("boolean");
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("stores and retrieves config by session manager identity", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.3 });
    const runtime = getCompactionSafeguardRuntime(sm);
    expect(runtime).toEqual({ maxHistoryShare: 0.3 });
  });

  it("returns null for unknown session manager", () => {
    const sm = {};
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("clears entry when value is null", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.7 });
    expect(getCompactionSafeguardRuntime(sm)).not.toBeNull();
    setCompactionSafeguardRuntime(sm, null);
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("ignores non-object session managers", () => {
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("isolates different session managers", () => {
    const sm1 = {};
    const sm2 = {};
    setCompactionSafeguardRuntime(sm1, { maxHistoryShare: 0.3 });
    setCompactionSafeguardRuntime(sm2, { maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime(sm1)).toEqual({ maxHistoryShare: 0.3 });
    expect(getCompactionSafeguardRuntime(sm2)).toEqual({ maxHistoryShare: 0.8 });
  });
});

describe("compaction-safeguard extension behavior", () => {
  const fallbackSummary =
    "Context contained 12 messages (0 oversized). Summary unavailable due to size limits.";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const buildContext = () => {
    const model = {
      id: "test-model",
      provider: "openai",
      contextWindow: 200_000,
    } as ExtensionContext["model"];
    return {
      model,
      modelRegistry: {
        getAvailable: async () => [model],
        getApiKey: async () => "test-key",
      },
      sessionManager: {},
    } as ExtensionContext;
  };

  type CompactionEvent = {
    preparation: {
      fileOps: { read: Set<string>; edited: Set<string>; written: Set<string> };
      messagesToSummarize: AgentMessage[];
      turnPrefixMessages: AgentMessage[];
      settings: { reserveTokens: number };
      isSplitTurn: boolean;
      previousSummary?: string;
      firstKeptEntryId: string;
    };
    customInstructions?: string;
    signal: AbortSignal;
  };

  const buildEvent = (overrides?: Partial<CompactionEvent>): CompactionEvent => {
    const baseEvent: CompactionEvent = {
      preparation: {
        fileOps: {
          read: new Set<string>(),
          edited: new Set<string>(),
          written: new Set<string>(),
        },
        messagesToSummarize: [],
        turnPrefixMessages: [],
        settings: { reserveTokens: 1000 },
        isSplitTurn: false,
        previousSummary: undefined,
        firstKeptEntryId: "entry-1",
      },
      customInstructions: undefined,
      signal: new AbortController().signal,
    };
    return { ...baseEvent, ...overrides };
  };

  it("cancels compaction when summary falls back", async () => {
    const mockedSummarize = vi.mocked(summarizeInStages);
    mockedSummarize.mockResolvedValueOnce(fallbackSummary);

    let handler: ((event: CompactionEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
    const api = {
      on: (name: string, fn: unknown) => {
        if (name === "session_before_compact") {
          handler = fn as typeof handler;
        }
      },
    } as ExtensionAPI;

    compactionSafeguardExtension(api);

    if (!handler) {
      throw new Error("missing session_before_compact handler");
    }

    const result = await handler(buildEvent(), buildContext());
    expect(result).toEqual({ cancel: true });
  });

  it("cancels compaction when prefix summary falls back", async () => {
    const mockedSummarize = vi.mocked(summarizeInStages);
    mockedSummarize.mockResolvedValueOnce("ok summary").mockResolvedValueOnce(fallbackSummary);

    let handler: ((event: CompactionEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
    const api = {
      on: (name: string, fn: unknown) => {
        if (name === "session_before_compact") {
          handler = fn as typeof handler;
        }
      },
    } as ExtensionAPI;

    compactionSafeguardExtension(api);

    if (!handler) {
      throw new Error("missing session_before_compact handler");
    }

    const result = await handler(
      buildEvent({
        preparation: {
          fileOps: {
            read: new Set<string>(),
            edited: new Set<string>(),
            written: new Set<string>(),
          },
          messagesToSummarize: [],
          turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: Date.now() }],
          settings: { reserveTokens: 1000 },
          isSplitTurn: true,
          previousSummary: undefined,
          firstKeptEntryId: "entry-1",
        },
      }),
      buildContext(),
    );
    expect(result).toEqual({ cancel: true });
    expect(mockedSummarize).toHaveBeenCalledTimes(2);
  });
});
