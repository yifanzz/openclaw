# .openclaw/ Folder Specification

## Purpose

The `.openclaw/` folder provides AI-readable state for orchestrating development work. It enables:

- **Resumability**: Any agent can pick up where another left off
- **Auditability**: Full history of AI decision-making in git
- **Coordination**: Lock prevents concurrent conflicting work
- **Context efficiency**: State is compact, loaded only when needed

## File Reference

### STATUS.md

Current project state. Updated frequently during work.

```markdown
# Project Status

**Current Task:** [one-line description]
**Agent:** [identifier - e.g., "steve", "codex-session-abc"]
**Started:** [ISO 8601 timestamp]
**Iterations:** [number]

## Checklist
- [x] Completed step
- [ ] Pending step

## Current State
[Paragraph describing what's done, what's blocking, key decisions made]

## Last Output
[Most recent relevant output from coding agent - errors, test results, etc.]

## Next Action
[Specific next step to attempt]
```

**Update triggers:**
- Task start
- Each iteration completion
- State change (blocked → progressing)
- Task completion

### LOG.md

Append-only session history. Never edited, only appended.

```markdown
# Session Log

## [timestamp] - [task name]
**Agent:** [identifier]
**Iterations:** [count]
**Outcome:** [Success | Failed | Paused | Escalated]

### Summary
- Key decision 1
- Key decision 2
- What was learned

### Commits
- [hash]: [message]

---

## [earlier timestamp] - [earlier task]
...
```

**Append triggers:**
- Task completion
- Task pause/switch
- Task escalation to user

### .lock

Runtime lock file. **Gitignored.**

```json
{
  "agent": "steve",
  "started": "2026-01-30T15:00:00Z",
  "task": "fix auth cleanup",
  "pid": 12345
}
```

**Fields:**
- `agent`: Identifier of lock holder
- `started`: When lock was acquired
- `task`: What's being worked on
- `pid`: (optional) Process ID for liveness check

**Stale lock policy:**
- Lock older than 2 hours with no matching process → can be broken
- Always log when breaking a stale lock

## Git Configuration

Add to project's `.gitignore`:

```
# OpenClaw orchestration
.openclaw/.lock
```

Do NOT ignore STATUS.md or LOG.md — they should be versioned.

## Project Location

All orchestrated projects live in `~/projects/`:

```bash
~/projects/
├── project-a/
│   ├── .openclaw/
│   └── ...
├── project-b/
│   ├── .openclaw/
│   └── ...
```

**Not orchestrated:**
- `~/openclaw-code/` — OpenClaw source, managed directly
- `~/clawd/` — workspace files, not a code project

## Initialization

To add a new project for orchestration:

```bash
# Clone to projects/
git clone <repo> ~/projects/<name>
cd ~/projects/<name>

# Add orchestration folder
mkdir -p .openclaw
touch .openclaw/STATUS.md .openclaw/LOG.md
echo ".openclaw/.lock" >> .gitignore
git add .openclaw/ .gitignore
git commit -m "chore: add .openclaw orchestration folder"
```

## Example Commit Flow

```bash
# Agent completes work
git add src/ tests/ .openclaw/STATUS.md .openclaw/LOG.md
git commit -m "feat: implement feature X

.openclaw: 2 iterations, tests passing"
```

The commit message references .openclaw to signal this was AI-assisted work.
