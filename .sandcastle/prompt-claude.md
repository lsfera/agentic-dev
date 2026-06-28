You are implementing GitHub issue #{{ISSUE_NUMBER}}: "{{ISSUE_TITLE}}"

## Issue
{{ISSUE_BODY}}

## Scope guardrails
- Only modify files directly required by this issue.
- Do not modify, close, or reference other issues.
- Do not add dependencies beyond what the issue specifies.
- Do not push or open a pull request — the orchestrator does that after you finish.
- Make the changes yourself: use the edit/write tools to modify files and bash
  to run tests and commit. Do not just plan or write a todo list, and do not
  delegate to a subagent — apply the edits and commit them directly.

## Steps
1. Implement the change. If the project has a test suite, work test-first:
   write a failing test, make it pass, then refactor.
2. Run the test suite and make sure it is green.
3. Commit your work to the current branch with clear, imperative messages
   referencing #{{ISSUE_NUMBER}}.
4. When the issue is fully implemented and committed, output exactly this
   line, by itself, and then stop — produce no further output or commits:
   <promise>ISSUE_COMPLETE</promise>
