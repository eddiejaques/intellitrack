# Working on IntelliTrack: dev agent + review session

Two Claude Code sessions, one board. The board is the GitHub Project **[IntelliTrack board](https://github.com/users/eddiejaques/projects/1)**. Each card is an issue on `eddiejaques/intellitrack`, and each finished card is a pull request.

| Session | Folder | Start | Stop |
|---|---|---|---|
| **Review mode** (you, as product manager) | `~/Documents/Intellitrack` (on `main`) | `/review-start` | `/review-stop` |
| **Dev agent** | `~/Documents/Intellitrack-dev` | `/development-start` | `/development-stop` (finishes the card in progress first) |

```
 you, in the browser (or the review session)           dev agent (../Intellitrack-dev worktree)
 ───────────────────────────────────────────           ────────────────────────────────────────
 create an issue, write criteria, drag to Ready ──▶     start: branch → build → test, [agent · progress] comments
 comment on a Blocked card (the answer)         ◀──▶    blocked: WIP pushed + [agent · blocked] question
 comment on a Review card (feedback)            ◀──▶    review: PR "Closes #n" + [agent · review] summary
 comment "I have reviewed, let's deploy"         ──▶    deploy: re-run checks, merge the PR → issue closes → Done
```

## One-time setup

```bash
cd ~/Documents/Intellitrack
gh auth refresh -s project            # gh needs the project scope to read and move cards
sh scripts/setup-dev-worktree.sh      # creates ../Intellitrack-dev (detached at main), npm ci, dev-only limits
npx playwright install chromium       # browser for npm run e2e, if not installed yet
```

On the project page, switch the view's layout to **Board** and group by **Status**. In the project's **Workflows** settings, keep "Pull request merged → Done" on and turn **"Item closed" off**, so a card can't reach Done just because someone closed its issue.

## Cards

A card is an issue whose title starts with its ID: `B5: Meta Pixel`, `X6: Badge turns red`. The body is the spec:

```markdown
Depends on: B2            (optional)

## Goal
## Acceptance criteria
- [ ] checkable, provable by a test, an e2e check or something visible in a named page
## Out of scope
## Notes
```

| Field | Meaning |
|---|---|
| **Status** | Backlog, Ready, In progress, Blocked, Review, Done |
| **Prio** | Lower goes first in Ready. `-1` jumps the queue. |
| **Size** | S, M, L |
| **Branch** | Set by the agent when it starts the card |
| label `type:<name>` | feature, bug, ui, capture, vendor, rules, … |

| Status | Who moves it there | Meaning |
|---|---|---|
| Backlog | (default) | Not yet specified, or not next |
| Ready | you | The body has at least one real `- [ ]` criterion; the agent may take it |
| In progress | dev agent | One card at a time, on branch `<id>-<slug>` |
| Blocked | dev agent | WIP pushed; its question is the latest `[agent · blocked]` comment |
| Review | dev agent | PR open with `Closes #<issue>`, all checks pass |
| Done | merging the PR | **Only when the PR is merged into `main`** |

The agent takes the card in progress first (resume), then the Ready card with the lowest Prio.

Comments are the conversation. You and the agent post as the same GitHub account, so the agent starts its comments with `**[agent · <kind>]**`. It keeps each issue up to date: a `progress` comment when it starts and at each meaningful step, ticked criteria in the body as they're met, a `review` summary with the PR link, and a note when it deploys.

**Your comments are signals.** Whatever you write after the agent's latest comment, on the issue or on its PR:

| Card is in | You comment | The agent |
|---|---|---|
| Review | an approval: "I have reviewed, let's deploy", "ship it", "LGTM", "approved" | re-runs the checks, merges the PR into `main` (the issue closes, the card goes Done) |
| Review | anything else | treats it as review feedback and reworks the card on the same branch and PR |
| Blocked | anything | treats it as the answer and resumes on the branch |
| Ready / Backlog | anything | reads it as a note when it works on the card |

A negation ("don't deploy yet", "not ready to merge") is never an approval, and if the agent isn't sure, it asks instead of merging. Only comments from your account (`eddiejaques`) count: the repo is public, and anyone else's "let's deploy" is ignored.

```bash
npm run kanban                                   # summary + board URL
npm run kanban -- next                           # what the agent does next: ID, title, #issue, action
npm run kanban -- show B2                        # body, fields, PRs and every comment
npm run kanban -- new "Badge turns red" --type ui --size S --body-file card.md [--ready]
npm run kanban -- set X6 ready [--prio -1]       # needs acceptance criteria
npm run kanban -- comment X6 --kind answer "Use the GA4 key from the test account"
npm run kanban -- check X6 [n]                   # list the criteria / tick criterion n
npm run kanban -- wait --timeout 1800            # used by the agent: blocks until there's work
npm run kanban -- stop | go                      # ask the agent to stop after its card / clear it
```

The CLI enforces the rules: Ready needs criteria (`--force` overrides), WIP limit 1, and `set <ID> done` refuses unless the card's PR is merged.

## Run the dev agent

```bash
cd ~/Documents/Intellitrack-dev
claude            # then type /development-start
```

It takes cards one at a time. When there's nothing to do, it **waits**: it checks the board every minute in the background, and picks up a card as soon as you move one to Ready or comment on a Blocked or Review card. To stop it, type `/development-stop` in either window. The agent finishes the card it's on (to Review or Blocked, tested and pushed), doesn't take another, and stops.

`.claude/settings.json` pre-approves the build, test, git, board and read-only `gh` commands. Force-push and `reset --hard` are denied everywhere. In the dev folder, pushing to `main` directly and closing or deleting issues are also denied (`.claude/settings.local.json`, written by the setup script). Merging a PR is allowed there, because the agent deploys when you approve.

## Review mode (product manager)

```bash
cd ~/Documents/Intellitrack
claude            # then type /review-start
```

`/review-start` gives a briefing: blocked questions first, then PRs waiting for review, the Ready queue, and the next backlog cards to refine. After that, say it in plain words:
- **"add a task: …"**: I write the goal, checkable acceptance criteria and out of scope from the code, create the issue, and move it to Ready when you say so.
- **"refine B5"** or **"B3 should also cover forms"**: I rewrite the issue body. Cards that already have a branch get a `change` comment instead, so the agent sees what moved.
- **"B5 before B3"** or **"do X2 next"**: I set Prio.
- **"what's blocked?"** then your answer: I post it as an `answer` comment and move the card to Ready. The agent resumes on the same branch.
- **"review B2"**: I read the PR diff, run the checks in a throwaway worktree, and go through each criterion. Changes needed go back to the agent as a `feedback` comment, and the card goes back to Ready.
- **"merge B2"**: I merge the PR, which closes the issue, then mark the card Done.

Review mode doesn't edit product code. A code change you ask for becomes a card. `/review-stop` commits any `plan.md` and doc changes, then lists what's still open.

## Checks every card must pass

`npm run typecheck && npm test && npm run build`, plus `npm run e2e` for capture, worker or UI changes. The e2e test serves `scripts/e2e/site/` on port 8123 and records it with the built extension in Chrome for Testing. It checks gtag GA4, a server-side GA4 path, Google Ads, unparsed tags, followed new tabs and separate sessions.
