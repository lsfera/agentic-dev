# `.sandcastle/` is organised into `src/`, `docker/` and `prompts/`

Refines the `.sandcastle/` location decision in ADR-0010 (location unchanged: still per project).

`.sandcastle/` had grown to 34 flat files mixing TypeScript, tests, Dockerfiles, prompt templates and launch scripts. It is now:

```
.sandcastle/
  run.sh  package.json  tsconfig.json  orchestrator.env(.example)   launcher + config
  src/      *.ts and *.test.ts (tests stay beside their sources); entrypoint src/main.ts
  docker/   Dockerfile, Dockerfile.opencode, Dockerfile.dotnet (build context remains .sandcastle/)
  prompts/  prompt-*.md, review-*.md
```

- `run.sh` resolves `src/main.ts` (workspace copy first, then the baked `/opt/agentic-orchestrator`).
- Build commands become `docker build -f .sandcastle/docker/Dockerfile … .sandcastle`; `publish-images.yml` follows.
- `opencode.json` stays at the repo root (it is copied from the worktree root), not in `.sandcastle/`.
- Older ADRs keep their original paths; they describe the layout at the time they were written.
