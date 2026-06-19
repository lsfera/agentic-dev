# /afk

Autonomous implementation loop. Runs without human input until all issues are done.

## Loop

Repeat until no open `ready-for-agent` issues remain:

### 1. Fetch ready issues

```
mcp__github__list_issues(state="open", labels=["ready-for-agent"])
```

If the list is empty → print "All issues complete." and stop.

### 2. Claim the next issue

Take the lowest-numbered issue. Remove the `ready-for-agent` label to mark it in-progress.

### 3. Spawn an implementation agent

Use the **Agent tool** with this self-contained prompt (fill in `<N>`, `<title>`, `<body>`):

---
```
You are implementing GitHub issue #<N>: "<title>"

## Issue
<body verbatim>

## Execution environment
All shell commands MUST go through /exec — it routes to the Docker sandbox
(service "devcontainer"). Never use the Bash tool directly.

## Scope guardrails
- Only modify files directly required by this issue
- Do not create, edit, or close other issues
- Do not push to main — commit to the current branch only
- Do not add dependencies beyond what the issue specifies

## Implementation approach
Use /tdd: write failing tests first, implement to green, refactor.

## Completion steps (in order)
1. /tdd for every acceptance criterion in the issue
2. /exec — run the full test suite; all tests must be green
3. Commit with an imperative message referencing #<N>
4. Comment on issue #<N> summarising what changed (one paragraph)
5. Close issue #<N>
```
---

### 4. After the agent returns

Verify the issue is closed. If not, investigate and retry.

### 5. Unblock dependents

Scan all open issues whose body contains `Blocked by #<N>`.
For each, check if ALL its blockers are now closed.
If yes → apply `ready-for-agent` label.

### 6. Continue loop

Go back to step 1.
