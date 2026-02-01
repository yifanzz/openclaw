# Divergence Notes

Purpose: Capture the goals behind local changes that are not obvious from the diffs. Use this
when rebasing onto upstream to decide whether to keep, adjust, or drop local changes.

Update rules:
- Keep this file in sync with local-only behavior changes.
- If upstream adopts the same goal, remove the local change and update this list.
- Include enough context to re-implement if needed.

## Current divergence goals

1) Compaction must fail closed to preserve history
- Goal: Never truncate history when compaction cannot produce a reliable summary.
- Rationale: Losing long conversation context is worse than failing the compaction.
- Behavior: If summarization fails, or returns the fallback summary, abort compaction and
  leave session history intact. Manual /compact replies should warn that history is preserved.
- Key files:
  - src/agents/pi-extensions/compaction-safeguard.ts
  - src/agents/pi-embedded-runner/run.ts
  - src/auto-reply/reply/commands-compact.ts
- Rebase check: If upstream introduces a safe fail-closed compaction mode, drop local changes
  and verify that manual /compact surfaces a failure message without truncation.

2) Embedded runs must initialize extension runner
- Goal: Ensure ctx.model and hooks are available during embedded runs (auto and manual compaction).
- Rationale: Extension hooks were running without ctx.model, causing fallback summaries.
- Behavior: Initialize the extension runner during embedded run/compact and avoid resource loader
  path that skipped initialization.
- Key files:
  - src/agents/pi-embedded-runner/compact.ts
  - src/agents/pi-embedded-runner/run/attempt.ts
- Rebase check: If upstream creates embedded sessions with extension runner initialized, drop
  local initialization helper and keep default session creation.

3) Improved overflow messaging when compaction aborts
- Goal: Tell users that auto-compaction failed and history was preserved.
- Rationale: Avoid confusing "compacted" messages when no usable summary exists.
- Behavior: Update overflow error message to mention auto-compaction failure and instruct
  manual /compact or smaller input.
- Key files:
  - src/agents/pi-embedded-runner/run.ts
- Rebase check: If upstream clarifies overflow messages or exposes compaction failure status
  in a similar way, remove local changes.

4) Slack exec approval block action handling
- Goal: Handle exec approval button actions without breaking tests or runtime.
- Rationale: New block actions require handling in the Slack monitor; tests need guard when
  app.action is missing in mocks.
- Behavior: Register exec approval block actions when app.action exists; resolve approvals via
  ctx.resolveExecApproval; update message with result.
- Key files:
  - src/slack/monitor/events/block-actions.ts
  - src/slack/monitor/events.ts
- Rebase check: If upstream adds equivalent block action handling, drop local file and restore
  upstream event registration.

5) Dev workflow convenience
- Goal: Reliable local dev restart without manual steps.
- Rationale: Gateway uses built dist; build + restart is required to test changes.
- Behavior: Provide script that runs pnpm build then pnpm openclaw gateway restart; note in
  AGENTS.md to use it.
- Key files:
  - scripts/restart-gateway-dev.sh
  - AGENTS.md
- Rebase check: If upstream adds a similar script or docs, drop local addition and reference
  upstream guidance.

6) Typecheck convenience command
- Goal: Run typechecks without emitting dist output.
- Rationale: Avoid build artifacts during quick validation.
- Behavior: Provide pnpm typecheck script that runs tsc --noEmit.
- Key files:
  - package.json
  - AGENTS.md
- Rebase check: If upstream adds a no-emit typecheck script, drop local changes.
