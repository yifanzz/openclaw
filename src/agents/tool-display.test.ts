import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

describe("tool display details", () => {
  it("skips zero/false values for optional detail fields", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: {
          task: "double-message-bug-gpt",
          label: 0,
          runTimeoutSeconds: 0,
          timeoutSeconds: 0,
        },
      }),
    );

    expect(detail).toBe("double-message-bug-gpt");
  });

  it("includes only truthy boolean details", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "message",
        args: {
          action: "react",
          provider: "discord",
          to: "chan-1",
          remove: false,
        },
      }),
    );

    expect(detail).toContain("provider discord");
    expect(detail).toContain("to chan-1");
    expect(detail).not.toContain("remove");
  });

  it("keeps positive numbers and true booleans", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_history",
        args: {
          sessionKey: "agent:main:main",
          limit: 20,
          includeTools: true,
        },
      }),
    );

    expect(detail).toContain("session agent:main:main");
    expect(detail).toContain("limit 20");
    expect(detail).toContain("tools true");
  });

  it("shows cron schedule for add action", () => {
    // cron expression with timezone
    const d1 = formatToolDetail(
      resolveToolDisplay({
        name: "cron",
        args: {
          action: "add",
          job: {
            name: "Daily PnL",
            schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
          },
        },
      }),
    );
    expect(d1).toContain("Daily PnL");
    expect(d1).toContain("0 9 * * *");
    expect(d1).toContain("Europe/London");

    // one-shot at schedule
    const d2 = formatToolDetail(
      resolveToolDisplay({
        name: "cron",
        args: {
          action: "add",
          job: {
            name: "Reminder",
            schedule: { kind: "at", at: "2026-02-11T17:00:00Z" },
          },
        },
      }),
    );
    expect(d2).toContain("Reminder");
    expect(d2).toContain("at 2026-02-11T17:00:00Z");

    // every interval
    const d3 = formatToolDetail(
      resolveToolDisplay({
        name: "cron",
        args: {
          action: "add",
          job: { schedule: { kind: "every", everyMs: 1800000 } },
        },
      }),
    );
    expect(d3).toContain("every 30m");
  });

  it("shows cron schedule for update action", () => {
    const d1 = formatToolDetail(
      resolveToolDisplay({
        name: "cron",
        args: {
          action: "update",
          jobId: "abc-123",
          patch: { schedule: { kind: "cron", expr: "30 8 * * 1" } },
        },
      }),
    );
    expect(d1).toContain("abc-123");
    expect(d1).toContain("30 8 * * 1");

    // update with name only
    const d2 = formatToolDetail(
      resolveToolDisplay({
        name: "cron",
        args: {
          action: "update",
          jobId: "abc-123",
          patch: { name: "Weekly Review" },
        },
      }),
    );
    expect(d2).toContain("abc-123");
    expect(d2).toContain("Weekly Review");
  });
});
