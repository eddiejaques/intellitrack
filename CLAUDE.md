# IntelliTrack: rules for every Claude session

IntelliTrack is a Chrome MV3 extension that captures marketing tags (GA4 first) while you browse and audits them with your own LLM. The spec is `plan.md`, the board is `kanban.md`, and usage is in `README.md` and `docs/workflows.md`.

## Two sessions, two roles
- **Review mode** (`/review-start` … `/review-stop`): the user as product manager, in the main checkout (`/Users/gauravkumardani/Documents/Intellitrack`), always on `main`. No product code is edited there. It writes cards (`tasks/<ID>.md`), answers blockers, reviews branches, and merges to `main` only when the user asks.
- **Dev agent** (`/development-start`, graceful stop with `/development-stop`) runs in the worktree `../Intellitrack-dev`, set up with `sh scripts/setup-dev-worktree.sh`. It sits detached at `main`, because `main` is checked out in the main checkout. It takes cards one at a time, works on a branch per card, and pushes the branch. It **never merges to `main`**.

## Board
- The board lives in the main checkout: `plan.md`, `tasks/`, `kanban.state.json`, `kanban.md`. `npm run kanban` finds it from any worktree.
- Move cards only with `npm run kanban -- set <ID> <status> [--branch b] [--note "…"]`. Statuses: backlog, ready, in_progress, blocked, review, done.
- Ad-hoc cards are `tasks/X<n>.md` (heading `# X<n>: title`, optional `Type:` and `Size:` lines). Backlog cards use the plan's B-ids.
- The dev session edits board files but doesn't commit them. The review session commits board changes on `main`.

## Code rules
- One branch per card, named `<id>-<slug>` in lower case (`b2-datalayer`), cut from an up-to-date `main`.
- Before pushing: `npm run typecheck && npm test && npm run build`. Also run `npm run e2e` (real Chrome) when the change touches capture, the background worker or UI pages.
- Add or update tests in `tests/` with every behaviour change. Keep `README.md` and `docs/workflows.md` true to what the extension does.
- UI: use the tokens and components in `extension/static/ui.css`. Pages must work in light and dark.
- Commit messages: imperative summary line, then why.

## Hard limits
- Never try to get around a third-party site's bot protection (no user-agent spoofing, no automation-flag tricks, no captcha solving). If a site blocks automated visits, block the card and say so.
- Never put the user's API keys, email or other personal details in code, fixtures, commits or requests to outside services. Fixtures use placeholder IDs.
- No force-pushes, no history rewrites, and no deleting branches you didn't create.
