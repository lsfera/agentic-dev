# /tdd

Implement a feature using Test-Driven Development.

**Input:** A feature description or acceptance criterion (from conversation or issue body).

**Red → Green → Refactor loop — never skip the red phase:**

1. **Red** — Write the failing test(s) for the acceptance criterion.
   - Run via `/exec <test-command>`
   - Confirm the test fails for the right reason (not a syntax error)

2. **Green** — Write the minimum code to make the test pass.
   - Run via `/exec <test-command>`
   - All new tests must pass; no existing tests may break

3. **Refactor** — Clean up without changing behaviour.
   - Run via `/exec <test-command>` again to confirm still green

4. Repeat for the next acceptance criterion.

**Rules:**
- Never write implementation before the failing test exists
- Minimum code means minimum — no speculative additions
- All `/exec` calls route to the Docker sandbox (`service="devcontainer"`)
