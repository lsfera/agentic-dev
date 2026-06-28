# /exec

Run a shell command — works in both host-driven and cockpit mode.

**Usage:** `/exec <command>`

**How (context-aware — single corpus, no forks):**

- **Cockpit mode** (`AGENTIC_IN_CONTAINER` is set in the environment): run the command using the Bash tool in the local shell.
- **Host mode** (no `AGENTIC_IN_CONTAINER`): call `mcp__docker__run_command` with `service: "devcontainer"`, routing to the sandbox over docker MCP.

Check `process.env.AGENTIC_IN_CONTAINER` (or `$AGENTIC_IN_CONTAINER` in the shell) to decide which path to take.

**This is the only shell-dispatch boundary.** All slash commands (including `/tdd`) call `/exec` — they work unchanged in both modes.

**Examples:**
- `/exec npm test`
- `/exec python -m pytest`
- `/exec docker ps`
