# /exec

Run a shell command in the Docker sandbox.

**Usage:** `/exec <command>`

**How:** Call `mcp__docker__run_command` with:
- `command`: the shell command to run
- `service`: `"devcontainer"`

**This is the only place `mcp__docker__run_command` is called.** All other commands use `/exec`.

**Examples:**
- `/exec npm test`
- `/exec python -m pytest`
- `/exec docker ps`
