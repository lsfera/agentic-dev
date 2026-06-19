# /grill-me-with-docs

Interview the user to fully understand the feature before writing any code.

## Steps

1. Ask the user: *"What are you building? Drop any relevant docs, URLs, or context."*

2. Read any links or files they provide.

3. Ask targeted follow-up questions until all of the following are clear:
   - **Who** is the user of this feature?
   - **What problem** does it solve?
   - **What does success look like?** (acceptance criteria)
   - **What is explicitly out of scope?**
   - **Any technical constraints** (language, framework, existing integrations)?
   - **Edge cases or failure modes** to handle?

4. Reflect back a structured summary:
   ```
   ## What we're building
   <one paragraph>

   ## Goals
   - ...

   ## Non-goals
   - ...

   ## Acceptance criteria
   - [ ] ...

   ## Constraints
   - ...
   ```

5. Ask: *"Does this capture it? Adjust anything before I write the PRD."*

6. Save the agreed summary to `docs/grill-output.md`.

7. Prompt: *"Run `/to-prd` when ready."*

## Rules
- Ask one cluster of questions at a time — not a wall of text
- Do not suggest solutions or implementation details during this phase
- Do not proceed to implementation until the user confirms the summary
