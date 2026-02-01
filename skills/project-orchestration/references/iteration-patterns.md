# Iteration Patterns

## Basic Iteration Loop

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (main agent)                │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Read STATUS.md  │
                    │   Acquire lock    │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Spawn coding     │
                    │  agent with task  │
                    └─────────┬─────────┘
                              │
              ┌───────────────▼───────────────┐
              │     CODING AGENT (worker)     │
              │  - Implements changes         │
              │  - Commits work               │
              │  - Returns SUMMARY:           │
              └───────────────┬───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Verify results   │
                    │  - Tests pass?    │
                    │  - Lint clean?    │
                    └─────────┬─────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
          [Issues found]             [All good]
                 │                         │
        ┌────────▼────────┐       ┌────────▼────────┐
        │ Resume with     │       │ Update LOG.md   │
        │ feedback        │       │ Release lock    │
        │ --resume --last │       │ Report to user  │
        └────────┬────────┘       └─────────────────┘
                 │
                 └──────────► (back to verify)
```

## Resume Patterns

### Codex

```bash
# First attempt
codex exec "Implement feature X. Commit when done."

# Iteration with preserved context
codex exec --resume --last "Tests are failing: [error]. Try approach Y."

# Continue until done
codex exec --resume --last "Almost there. Fix the edge case on line 42."
```

### Claude Code

```bash
# First attempt
claude "Implement feature X. Commit when done."

# Resume with session ID
claude --resume <session-id> "Tests failing. Try Y."

# Or continue most recent
claude --continue "Fix the remaining issue."
```

## Feedback Patterns

### Specific and Actionable

```
❌ Bad: "It's not working"
✅ Good: "Tests failing on auth.test.js line 42: expected 'success' but got 'pending'"

❌ Bad: "Try something else"
✅ Good: "The race condition is in the async handler. Try using a mutex or queue."
```

### Include Context

```
"Previous approach failed because X.
Current error: Y.
Constraints: must not break Z.
Suggested direction: consider A or B."
```

## Parallel Iteration

For independent tasks, run multiple workers:

```bash
# Start parallel workers
bash pty:true workdir:~/project background:true \
  command:"codex exec 'Fix bug #123. Commit when done.'"
# → session: abc

bash pty:true workdir:~/project background:true \
  command:"codex exec 'Add feature #456. Commit when done.'"
# → session: def

# Monitor both
process action:list

# Iterate on each independently
codex exec --resume --last "session abc feedback..."
codex exec --resume --last "session def feedback..."
```

**Caution:** Parallel workers should not modify the same files. Use git worktrees for conflicting changes.

## Escalation Patterns

### When to Escalate

| Situation | Action |
|-----------|--------|
| Tests fail 2+ times | Escalate with attempts summary |
| Unclear requirements | Ask for clarification |
| Architectural decision | Present options, ask for direction |
| Security-sensitive | Always escalate |
| External dependency | Escalate with options |

### How to Escalate

```markdown
## Need Help: [project-name]

**Task:** [what was being attempted]
**Attempts:** [count]

### What I Tried
1. Approach A → failed because X
2. Approach B → failed because Y

### Current State
[Where things stand]

### Options
1. Option A: [tradeoffs]
2. Option B: [tradeoffs]

### My Recommendation
[If you have one]

### What I Need
[Specific decision or information required]
```

## Recovery Patterns

### Stale Lock

```bash
# Check lock age
lock_time=$(cat .openclaw/.lock | jq -r .started)
# If older than 2 hours and no process running → break it

# Log the break
echo "## $(date -Iseconds) - Lock Recovery" >> .openclaw/LOG.md
echo "Broke stale lock from $lock_time" >> .openclaw/LOG.md

# Remove and reacquire
rm .openclaw/.lock
```

### Failed Midway

```bash
# Read STATUS.md for context
cat .openclaw/STATUS.md

# Check git status for uncommitted work
git status
git diff

# Either commit WIP or reset
git stash  # or git reset --hard

# Resume from clean state
```
