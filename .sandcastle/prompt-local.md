Implement this change in the repository, then commit. Use your tools now — read files, edit files, run bash. Do not just describe a plan.

TASK (issue #{{ISSUE_NUMBER}}): {{ISSUE_TITLE}}
{{ISSUE_BODY}}

The code lives in the `.sandcastle/` directory (TypeScript). Steps:
1. Read the relevant `.sandcastle/*.ts` file(s) with your read tool.
2. Make the change with your edit tool.
3. Run the tests: `cd .sandcastle && npm test` — fix until they pass.
4. Commit: `cd .sandcastle && cd .. && git add -A && git commit -m "<message> (#{{ISSUE_NUMBER}})"`
5. Do NOT push or open a PR.

When committed, output this exact line alone and stop:
<promise>ISSUE_COMPLETE</promise>

Begin now by reading the most relevant file.
