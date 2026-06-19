# /hitl

Human-in-the-loop implementation. Same as `/afk` but pauses after each issue for your approval.

## Loop

Repeat until no open `ready-for-agent` issues remain:

### 1. Fetch ready issues

```
mcp__github__list_issues(state="open", labels=["ready-for-agent"])
```

If the list is empty → print "All issues complete." and stop.

### 2. Claim the next issue

Take the lowest-numbered issue. Remove the `ready-for-agent` label.

### 3. Spawn an implementation agent

Same prompt as `/afk` — see that command for the full template.
The agent uses `/tdd` and `/exec` (Docker sandbox) for all implementation.

### 4. Show a review summary

After the agent returns, display:
- Issue title and number
- Files changed (git diff --stat)
- Test results summary

### 5. Ask for approval

```
Approve and move to next issue? (yes / no / edit)
```

- **yes** → close the issue, unblock dependents (add `ready-for-agent` where all blockers are now closed), continue loop
- **no** → revert the changes, re-open planning for this issue, stop loop
- **edit** → wait for your instructions, re-run the agent with updated guidance, then re-ask

### 6. Continue loop

Go back to step 1.
