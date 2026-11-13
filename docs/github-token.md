# GitHub token for the orchestrator

`afk` / `hitl` need a GitHub token for the **orchestrator process only** (its `gh` calls).
It lives in `.sandcastle/orchestrator.env` (gitignored), never in `.sandcastle/.env`, so it is
not injected into the inner sandboxes — the implementing agent never sees it.

## What the token is used for

| Operation | Where | Needs |
|-----------|-------|-------|
| List / view / edit / comment / create issues; apply `ready-for-agent`, `agent:*` labels | `issue-source`, `attempts` | Issues: write |
| Create labels idempotently on startup | `main` | Issues: write |
| List / view / diff / create / merge PRs | `main`, `reviewer-adapter` | Pull requests: write, Contents: write (merge) |
| Read branch protection / rulesets (merge preflight) | `preflight` | Administration: read (or repo admin) |

Pushing the agent's branch is **not** done with this token: it goes over the devcontainer's
SSH agent (ADR-0026).

## Required permissions

**Fine-grained PAT (recommended)** — scoped to this one repository:

- Issues: Read and write
- Pull requests: Read and write
- Contents: Read and write
- Administration: Read (without it the preflight cannot read branch protection and refuses to merge)
- Metadata: Read (automatic)

**Classic / OAuth token** — the `repo` scope (plus `workflow` if a run touches
`.github/workflows`). This is what `gh auth token` returns. It works, but it carries every
scope of your login across all your repositories, and `gho_` tokens do not expire — avoid it
for unattended runs.

## Create it

```sh
scripts/setup-gh-token.sh --fine-grained   # recommended: guided, repo-scoped, 90-day expiry
scripts/setup-gh-token.sh                  # quick: reuse your `gh auth token`
scripts/setup-gh-token.sh --check          # verify whatever is in orchestrator.env
```

GitHub has no API for minting fine-grained PATs, so `--fine-grained` opens a pre-filled
creation page (name, description, expiry, permissions — if GitHub ignores any pre-fill, set
them as listed above and choose **Only select repositories → this repo**), then reads the
pasted token silently. In every mode the script then verifies the token against the real
operations above and, only if they pass, writes `GH_TOKEN=` into the env file (mode 600). The
token is never printed.

Options: `--repo owner/name`, `--env-file PATH`.

## Verify and rotate

`scripts/setup-gh-token.sh --check` reports the token type, scopes and expiry (when GitHub
returns them), repository permissions, and whether issues, labels, PRs and branch protection
are reachable. Re-run it before a long `afk` run. To rotate, revoke the old token in GitHub
settings and re-run the script; there is nothing else to change.

For a shared or long-lived deployment, a GitHub App installation token (Issues, Pull requests,
Contents write; Administration read) avoids tying the automation to a person — set it as
`GH_TOKEN` the same way.
