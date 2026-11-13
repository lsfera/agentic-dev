#!/usr/bin/env bash
# Create/verify the orchestrator's GitHub token (docs/github-token.md).
#
#   scripts/setup-gh-token.sh                  # default: reuse your `gh auth token` (quick, broad)
#   scripts/setup-gh-token.sh --fine-grained   # guided: least-privilege, repo-scoped PAT (recommended)
#   scripts/setup-gh-token.sh --check          # verify the token already in the env file
#
# Options: --repo owner/name   (default: the current repo)
#          --env-file PATH     (default: .sandcastle/orchestrator.env)
#
# The token is written to the (gitignored) env file with mode 600 and is NEVER printed.
# GitHub has no API to mint fine-grained PATs, so --fine-grained opens a pre-filled
# creation page and reads the pasted token silently; everything else is automated.
set -euo pipefail

MODE=from-gh
REPO=""
ENV_FILE=".sandcastle/orchestrator.env"
while [ $# -gt 0 ]; do
  case "$1" in
    --from-gh) MODE=from-gh ;;
    --fine-grained) MODE=fine-grained ;;
    --check) MODE=check ;;
    --repo) REPO="${2:?--repo needs owner/name}"; shift ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
[ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

read_env_token() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E '^GH_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' " || true
}

write_env_token() { # $1 = token; replaces/creates the GH_TOKEN= line without exposing it in argv
  local tmp
  mkdir -p "$(dirname "$ENV_FILE")"
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "${ENV_FILE}.example" ]; then cp "${ENV_FILE}.example" "$ENV_FILE"; else : > "$ENV_FILE"; fi
  fi
  tmp="$(mktemp)"
  TOKEN="$1" awk 'BEGIN{done=0} /^GH_TOKEN=/ && !done {print "GH_TOKEN=" ENVIRON["TOKEN"]; done=1; next} {print} END{if(!done) print "GH_TOKEN=" ENVIRON["TOKEN"]}' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  chmod 600 "$ENV_FILE"
}

ok=0; fail=0; warn=0
pass() { echo "  ✔ $*"; ok=$((ok+1)); }
bad()  { echo "  ✘ $*"; fail=$((fail+1)); }
soft() { echo "  ! $*"; warn=$((warn+1)); }

check_token() { # $1 = token. Read-only probes of everything the orchestrator calls.
  local t="$1" hdr kind login
  [ -n "$t" ] || { bad "no token (GH_TOKEN is empty in $ENV_FILE)"; return; }
  case "$t" in
    github_pat_*) kind="fine-grained PAT" ;;
    ghp_*) kind="classic PAT" ;;
    gho_*) kind="OAuth token (gh auth login)" ;;
    ghs_*) kind="installation token" ;;
    *) kind="unknown format" ;;
  esac
  echo "Token: $kind, ${#t} chars, repo $REPO"
  hdr="$(curl -s -D- -o /dev/null -H "Authorization: Bearer $t" https://api.github.com/user)"
  if ! printf '%s' "$hdr" | head -1 | grep -q ' 200'; then
    # fine-grained/installation tokens may not read /user; fall back to the repo itself
    if ! GH_TOKEN="$t" gh api "repos/$REPO" >/dev/null 2>&1; then bad "token rejected by GitHub (expired, revoked or no access to $REPO)"; return; fi
  else
    login="$(GH_TOKEN="$t" gh api user -q .login)"; pass "authenticates as $login"
  fi
  printf '%s' "$hdr" | grep -i '^x-oauth-scopes:' | sed 's/^/    /;s/\r//' || true
  printf '%s' "$hdr" | grep -i '^github-authentication-token-expiration:' | sed 's/^/    /;s/\r//' || true
  local perms
  perms="$(GH_TOKEN="$t" gh api "repos/$REPO" -q '.permissions' 2>/dev/null || true)"
  [ -n "$perms" ] && pass "can see $REPO: $perms" || { bad "cannot read $REPO"; return; }
  GH_TOKEN="$t" gh issue list -R "$REPO" --label ready-for-agent --limit 1 --json number >/dev/null 2>&1 \
    && pass "issues: list" || bad "issues: list (needs Issues: read)"
  GH_TOKEN="$t" gh label list -R "$REPO" --limit 1 >/dev/null 2>&1 \
    && pass "labels: list" || bad "labels: list"
  GH_TOKEN="$t" gh pr list -R "$REPO" --limit 1 >/dev/null 2>&1 \
    && pass "pull requests: list" || bad "pull requests: list (needs Pull requests: read)"
  if [ "$(printf '%s' "$perms" | jq -r '.push // false')" = "true" ]; then pass "write access (issues/labels/PRs/merge)"
  else bad "no write access: orchestrator must label/comment/create/merge (needs Issues, Pull requests, Contents: write)"; fi
  local branch prot
  branch="$(GH_TOKEN="$t" gh api "repos/$REPO" -q .default_branch 2>/dev/null || echo main)"
  prot="$(GH_TOKEN="$t" gh api "repos/$REPO/branches/$branch/protection" 2>&1 || true)"
  if printf '%s' "$prot" | jq -e . >/dev/null 2>&1 && ! printf '%s' "$prot" | jq -e '.message' >/dev/null 2>&1; then
    pass "branch protection readable on $branch"
  elif GH_TOKEN="$t" gh api "repos/$REPO/rules/branches/$branch" >/dev/null 2>&1; then
    pass "branch rules readable on $branch (ruleset)"
  else
    soft "cannot read branch protection on $branch — afk's preflight will refuse to merge (needs Administration: read, or admin)"
  fi
}

summary() {
  echo; echo "$ok passed, $warn warning(s), $fail failed"
  [ "$fail" -eq 0 ]
}

case "$MODE" in
  check)
    check_token "$(read_env_token)"; summary ;;
  from-gh)
    t="$(gh auth token 2>/dev/null || true)"
    [ -n "$t" ] || { echo "gh is not logged in (run: gh auth login)" >&2; exit 1; }
    echo "Using your gh login token. It carries all of that login's scopes — prefer --fine-grained for unattended afk runs."
    check_token "$t"
    if [ "$fail" -eq 0 ]; then write_env_token "$t"; echo "Wrote GH_TOKEN to $ENV_FILE (mode 600)."; fi
    summary ;;
  fine-grained)
    q="name=agentic-dev-orchestrator&description=afk%2Fhitl+orchestrator+for+${REPO//\//%2F}&expires_in=90"
    q="$q&issues=write&pull_requests=write&contents=write&administration=read"
    url="https://github.com/settings/personal-access-tokens/new?$q"
    cat <<EOF
Create a fine-grained token (GitHub cannot do this via API):

  $url

On that page: set Resource owner to the repo owner, choose "Only select repositories" →
$REPO, and confirm Repository permissions: Issues R/W, Pull requests R/W, Contents R/W,
Administration Read (Metadata Read is automatic). Then Generate token and paste it below.
EOF
    (command -v open >/dev/null && open "$url") || (command -v xdg-open >/dev/null && xdg-open "$url") >/dev/null 2>&1 || true
    printf 'Paste token (input hidden): '; IFS= read -r -s t; echo
    t="$(printf '%s' "$t" | tr -d '[:space:]')"
    check_token "$t"
    if [ "$fail" -eq 0 ]; then write_env_token "$t"; echo "Wrote GH_TOKEN to $ENV_FILE (mode 600)."; fi
    summary ;;
esac
