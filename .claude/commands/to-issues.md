# /to-issues

Break the PRD into GitHub issues as vertical slices, then label the ones ready for the agent.

## Input

Read `docs/prd.md` (written by `/to-prd`).

## Steps

### 1. Create the `ready-for-agent` label

Check if the label exists. If not, create it via GitHub API:
- Name: `ready-for-agent`
- Color: `0075ca`
- Description: `Issue has no blockers and can be picked up by the implementation agent`

### 2. Create issues as vertical slices

Each issue must be **end-to-end deliverable value** — not a layer (not "write the DB schema", but "user can log in").

For each slice, create a GitHub issue with:
```
Title: <imperative verb phrase>

## What
<one paragraph describing the deliverable>

## Acceptance criteria
- [ ] AC-n: <from PRD, scoped to this slice>

## Blockers
Blocked by #<n>, #<m>   ← omit line if no blockers
```

### 3. Apply `ready-for-agent` label

Apply it to every issue whose **Blockers** line is empty (no dependencies).

### 4. Output a summary table

| # | Title | Blockers | ready-for-agent |
|---|-------|----------|-----------------|
| 1 | ...   | —        | ✓               |
| 2 | ...   | #1       | —               |

## After writing

Prompt: *"Run `/afk` to implement autonomously, or `/hitl` for reviewed implementation."*
