#!/bin/sh
# One-time setup for the dev agent's folder (../Intellitrack-dev).
# main stays checked out in the main checkout, so the worktree starts detached at main.
set -e
cd "$(git rev-parse --show-toplevel)"
DEV="${1:-../Intellitrack-dev}"
if [ -d "$DEV" ]; then echo "$DEV already exists"; else git worktree add --detach "$DEV" main; fi
cd "$DEV"
mkdir -p .claude
# dev-agent-only limits (not shared with the review session). The agent may merge a PR after the PM's
# approval comment, but never pushes to main directly or closes issues by hand.
cat > .claude/settings.local.json <<'JSON'
{
  "permissions": {
    "deny": [
      "Bash(git push origin main:*)",
      "Bash(git push origin HEAD:main:*)",
      "Bash(git checkout main)",
      "Bash(gh issue close:*)",
      "Bash(gh issue delete:*)"
    ]
  }
}
JSON
[ -d node_modules ] || npm ci
echo "Dev worktree ready: cd $(pwd) && claude, then /development-start"
