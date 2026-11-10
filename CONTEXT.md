# agentic.dev

A reusable devcontainer and host-driven workflow for running AI coding agents against a project inside Docker isolation. An in-container **orchestrator** spins up multiple disposable **agentic sandboxes**, one per unit of work.

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

**Host-driven mode**:
Claude Code runs on the host and reaches the outer devcontainer through `/exec` (docker MCP). The default for the dogfood.
_Avoid_: remote mode.

**Cockpit mode**:
Claude Code runs inside the outer devcontainer (`cockpit` command, ADR-0018). `/afk` and `/hitl` detach as background jobs with a log and PID file under `.sandcastle/`.
_Avoid_: in-container mode.

**Tier**:
Which agent powers the implementing sandbox: `claude` (Claude Code, default) or `local` (opencode + host Ollama).
_Avoid_: backend, provider.

**ready-for-agent**:
The GitHub label marking an unblocked issue the orchestrator may claim. Companion lifecycle labels: `agent:in-progress`, `agent:in-review`.
_Avoid_: todo, queued.

**In-flight**:
An issue currently being implemented or reviewed. Authoritative in orchestrator runtime state; mirrored to labels so a restart can recover it (ADR-0021).

**Review gate**:
The reviewer sandbox that must return a `pass` verdict on a PR before `/afk` enables auto-merge (ADR-0020).
_Avoid_: approval (reserved for the `/hitl` human merge gate).

**Vertical slice**:
An issue delivering end-to-end value through all layers, as opposed to a horizontal layer of work. What `/to-issues` produces.
