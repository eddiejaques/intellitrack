# IntelliTrack: rules for every Claude session

IntelliTrack is a Chrome MV3 extension that captures marketing tags (GA4 first) while you browse and audits them with your own LLM. The spec is `plan.md`, the board is the GitHub Project https://github.com/users/eddiejaques/projects/1 (`npm run kanban` prints it), and usage is in `README.md` and `docs/workflows.md`.

## Two sessions, two roles
- **Review mode** (`/review-start` … `/review-stop`): the user as product manager, in the main checkout (`/Users/gauravkumardani/Documents/Intellitrack`), always on `main`. No product code is edited there. It writes cards (GitHub issues), answers blockers, reviews PRs, and merges them to `main` only when the user asks.
- **Dev agent** (`/development-start`, graceful stop with `/development-stop`) runs in the worktree `../Intellitrack-dev`, set up with `sh scripts/setup-dev-worktree.sh`. It sits detached at `main`, because `main` is checked out in the main checkout. It takes Ready cards one at a time, works on a branch per card, pushes the branch and opens a PR (`Closes #<issue>`). It keeps the card's issue up to date with `[agent · …]` comments and ticked criteria. It merges a card's PR **only** when the PM has approved it in a comment on that card (e.g. "I have reviewed, let's deploy"); it never pushes to `main` directly or closes an issue by hand. When nothing is Ready it **refines Backlog cards**: it rewrites the issue's spec as a short brief (goal, a few criteria, files) and posts an `[agent · refine]` comment; if the scope is unclear it asks instead (`[agent · clarify]`, card to Blocked), but creates no branch and writes no code. Only the PM moves a card to Ready, and only then does work start.

## Board
- The board is a GitHub Project on `eddiejaques/intellitrack`. A card is an issue titled `<ID>: <title>` (plan B-ids, MVP T-ids, ad-hoc `X<n>`). Its column is the **Status** field (Backlog, Ready, In progress, Blocked, Review, Done); **Prio** (lower goes first), **Size** and **Branch** are fields; the type is a `type:<name>` label. Needs `gh` with the `project` scope.
- Sessions read and move cards with `npm run kanban` (`next`, `show`, `set`, `new`, `comment`, `wait`, `stop`, `go`). The user may also edit the board in the browser.
- Ready needs a full spec in the issue body: a non-empty `## Goal`, at least 2 real `- [ ]` acceptance criteria, and a `## Notes` section naming at least one file (text under `## Original request` doesn't count). `kanban -- set <ID> ready` lists what's missing; `--force` overrides. Only the PM moves a card to Ready (`kanban -- set <ID> ready` refuses from the dev worktree). WIP limit 1.
- **Done only happens when the card's PR is merged into `main`.** `kanban -- set <ID> done` refuses otherwise. Nobody closes a card's issue by hand.
- The PM and the agent share one GitHub account, so the agent's comments start with `**[agent · <kind>]**`. The newest PM answer, feedback or change comment wins over the issue body.
- The PM's comments in the browser are signals (only comments from the owner's account count; the repo is public). On a Review card, an approval ("I have reviewed, let's deploy", "ship it", "LGTM", "approved") means deploy: merge the PR. Any other comment on a Review card is feedback. Any comment on a Blocked card is the answer. Any comment on a Backlog card asks the agent to refine its spec again. `npm run kanban -- next` turns these into the actions `deploy`, `feedback`, `answer` and `refine`.

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
