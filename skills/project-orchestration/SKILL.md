---
name: project-orchestration
description: Orchestrate long-running work across multiple code projects. Use when managing multi-project development, delegating to coding agents, tracking progress via .openclaw/ folders, and iterating until work is complete. NOT for openclaw-code itself.
---

# Project Orchestration

Manage long-running development work across multiple repositories using coding agents (Codex, Claude Code) as workers.

## ⚠️ Scope

**This skill applies to:** Projects checked out in `~/projects/<name>/`

**This skill does NOT apply to:**
- `~/openclaw-code/` — managed directly, not via orchestration
- `~/clawd/` — workspace, not a code project

New projects should be cloned to `~/projects/`:
```bash
git clone <repo> ~/projects/<name>
```

## Core Concepts

### The `.openclaw/` Folder

Every project under orchestration has a `.openclaw/` folder at its root:

```
project-repo/
├── .openclaw/
│   ├── STATUS.md      # Current state, checklist, next actions
│   ├── LOG.md         # Append-only session history
│   └── .lock          # Runtime lock (gitignored)
├── src/
└── ...
```

**Committed to git:** STATUS.md and LOG.md are versioned with the code, keeping state and implementation in sync.

**Gitignored:** `.lock` is ephemeral runtime state.

### Lock Protocol

Before starting work on a project:

```bash
# Check if locked
if [ -f .openclaw/.lock ]; then
  cat .openclaw/.lock  # See who has it
fi
```

**Lock format:**
```json
{
  "agent": "steve",
  "sessionKey": "agent:main:slack:channel:c0aam7b786p",
  "started": "2026-01-30T15:00:00Z",
  "task": "fix auth"
}
```

**Stale lock detection:**
- If `sessionKey` matches your current session → you hold the lock, continue
- If lock is >2 hours old → likely stale, safe to break
- If `sessionKey` refers to a session that no longer exists → stale

**Acquire lock:**
```bash
echo '{"agent":"steve","sessionKey":"<your-session-key>","started":"2026-01-30T15:00:00Z","task":"fix auth"}' > .openclaw/.lock
```

Release lock when done or on error.

## Workflow

### 1. Starting Work

```bash
# Read current state
cat project/.openclaw/STATUS.md

# Acquire lock (include your sessionKey for stale detection)
echo '{"agent":"main","sessionKey":"<your-session-key>","started":"...","task":"..."}' > project/.openclaw/.lock

# Spawn coding agent
bash pty:true workdir:~/project background:true \
  command:"codex exec 'Your task. Commit when done. Output SUMMARY: <what you did>'"
```

### 2. Iteration Loop

```bash
# Check progress
process action:log sessionId:XXX

# If issues found, continue with context preserved
bash pty:true workdir:~/project command:"codex exec --resume --last 'Tests failing on line 42. Try X instead.'"

# Repeat until confident
```

### 3. Verification

Before releasing to user, verify:

- [ ] Tests pass (`pnpm test` or equivalent)
- [ ] Linter clean
- [ ] Changes committed
- [ ] Scope matches task (no unrelated changes)

### 4. Completion

```bash
# Update status
# Append summary to LOG.md
# Commit state with code
git add . && git commit -m "feat: completed task

.openclaw: 3 iterations, tests passing"

# Release lock
rm .openclaw/.lock

# Report to user (only now!)
```

## STATUS.md Format

```markdown
# Project Status

**Current Task:** [description]
**Agent:** [who's working]
**Started:** [timestamp]
**Iterations:** [count]

## Checklist
- [ ] Step 1
- [x] Step 2
- [ ] Step 3

## Current State
[What's done, what's blocking]

## Last Output
[Recent agent output or error]

## Next Action
[What to try next]
```

## LOG.md Format

```markdown
# Session Log

## 2026-01-30T15:00:00Z - fix auth cleanup
**Agent:** steve (via codex)
**Iterations:** 3
**Outcome:** Success

### Summary
- Identified issue in dispatch.js line 142
- Fixed timing race condition
- Added test coverage

### Commits
- abc1234: fix: resolve ack reaction cleanup timing
- def5678: test: add cleanup verification
```

## Confidence Criteria

### Return to user when CONFIDENT:
- Tests pass
- Linter clean
- Commits made
- Changes match task scope
- No obvious regressions

### Escalate to user when STUCK:
- Tests fail after 2+ attempts
- Unclear requirements
- Needs architectural decision
- External dependency issue
- Security-sensitive change

## Multi-Project Switching

When switching between projects:

1. Summarize current work → append to LOG.md
2. Update STATUS.md with next actions
3. Commit state
4. Release lock
5. Move to new project

## Integration with coding-agent Skill

This skill orchestrates work; `coding-agent` provides the execution layer:

```
project-orchestration          coding-agent
├── What to work on           ├── How to run agents
├── State tracking            ├── PTY requirements  
├── Iteration logic           ├── Background mode
├── Verification              ├── Parallel execution
└── User communication        └── Resume patterns
```

Use both together: orchestration decides, coding-agent executes.
