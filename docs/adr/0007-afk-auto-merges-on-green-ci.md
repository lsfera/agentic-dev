# /afk auto-merges PRs on green CI; /hitl keeps the human gate

Each issue produces a branch and a PR (git-isolated, ADR-0001). In `/afk` mode the PR auto-merges once CI is green, immediately unblocking dependents so a multi-layer dependency graph can clear in a single autonomous run. `/hitl` keeps a human merge gate and pauses between issues.

## Hard requirement this creates

- **CI is the only safety net.** Every project run under `/afk` must have meaningful, *required* status checks and branch protection configured so auto-merge gates on something real. Without trustworthy CI, `/afk` merges unreviewed, possibly-broken code to the main branch.

## Mechanism

- Prefer GitHub-native auto-merge (`gh pr merge --auto`) so GitHub performs the merge when checks pass; the orchestrator enables it rather than polling CI and merging itself.

## Consequences

- Truly hands-off multi-layer runs, at the cost of unreviewed merges — accepted, bounded by required CI and serial execution (ADR-0003).
- Because auto-merge completes asynchronously (whenever CI finishes), the serial orchestrator loop and dependency relabeling must reconcile with merges that land after the sandbox has closed — see ADR-0008.
- A bad early merge can cascade into dependents; serial execution limits the blast radius to one issue at a time.
