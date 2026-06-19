# /to-prd

Convert the grilling output into a structured PRD.

## Input

Read `docs/grill-output.md` (written by `/grill-me-with-docs`).
If it doesn't exist, work from the current conversation context.

## Output

Write a complete PRD to `docs/prd.md`:

```markdown
# PRD: <feature name>

## Overview
<one paragraph — what and why>

## Goals
- ...

## Non-goals
- ...

## User stories
As a <who>, I want <what>, so that <why>.
- US-1: ...
- US-2: ...

## Acceptance criteria
- [ ] AC-1: ...
- [ ] AC-2: ...

## Technical requirements
- TR-1: ...

## Out of scope
- ...

## Open questions
- ...
```

## Rules
- Each acceptance criterion must be testable and unambiguous
- User stories must map to acceptance criteria
- No implementation details — what, not how
- If there are open questions, flag them rather than assuming

## After writing

Show the PRD inline and prompt: *"Run `/to-issues` to break this into GitHub issues."*
