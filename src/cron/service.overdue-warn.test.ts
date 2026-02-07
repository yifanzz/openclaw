import { describe, expect, it, vi } from "vitest";
import { createJob } from "./service/jobs.js";
import { createCronServiceState } from "./service/state.js";
import { runDueJobs } from "./service/timer.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("CronService overdue warnings", () => {
  it("warns when a job is overdue by more than a minute", async () => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    const fixedNow = Date.parse("2026-02-07T00:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));

    const state = createCronServiceState({
      nowMs: () => fixedNow,
      storePath: "/tmp/openclaw-cron-overdue.json",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    const job = createJob(state, {
      name: "overdue",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hi" },
    });

    job.state.nextRunAtMs = fixedNow - 120_000;
    state.store = { version: 1, jobs: [job] };

    await runDueJobs(state);

    expect(noopLogger.warn).toHaveBeenCalledTimes(1);
    expect(noopLogger.warn.mock.calls[0]?.[1]).toBe(
      "cron: job overdue; timer likely stalled or system slept",
    );
  });
});
