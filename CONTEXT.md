# agentic.dev

A reusable devcontainer and host-driven workflow for running AI coding agents against a project inside Docker isolation. This context is being extended so an in-container **orchestrator** can spin up multiple disposable **agentic sandboxes**, one per unit of work.

## Language

**Outer devcontainer**:
The long-lived container in which a human and the orchestrator work. It is the orchestrator's home, not where agent work executes.
_Avoid_: "the sandbox" (now ambiguous), host.

**Agentic sandbox**:
A disposable inner container the orchestrator spins up to run a single agent's unit of work, then tears down. Distinct from the outer devcontainer that launched it.
_Avoid_: "the sandbox" (bare), container, worker, inner devcontainer.

**Orchestrator**:
The process running inside the outer devcontainer (sandcastle) that creates agentic sandboxes, runs the agent loop in each, and collects results.
_Avoid_: driver, runner, controller.

**Git-isolated**:
The model by which code crosses the boundary into and out of an agentic sandbox: each sandbox gets its own checkout and the agent commits to a named branch pushed back to the remote. Contrast with bind-mounting a shared worktree.
_Avoid_: branch strategy (implementation term), mounted.
