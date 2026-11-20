# Working on IntelliTrack: dev agent + review session

Two Claude Code sessions, one board. Each has a start command:

| Session | Folder | Start | Stop |
|---|---|---|---|
| **Review mode** (you, as product manager) | `~/Documents/Intellitrack` (on `main`) | `/review-start` | `/review-stop` |
| **Dev agent** | `~/Documents/Intellitrack-dev` | `/development-start` | `/development-stop` (finishes the card in progress first), or stops by itself when nothing is Ready |

```
 review session (main checkout, on main)            dev agent (../Intellitrack-dev worktree)
 ─────────────────────────────────────────           ────────────────────────────────────────
 write tasks/<ID>.md, set card → ready   ──board──▶  /development-start: next card → branch → build → test
 read Blocked questions, answer, → ready ◀──board──  blocked: WIP pushed + question in tasks/<ID>.md
 review branch, merge when you say so    ◀──git────  review: branch pushed + summary note
```

The board files (`plan.md`, `tasks/`, `kanban.state.json`, `kanban.md`) live in the **main checkout**. `npm run kanban` finds them from either folder, so both sessions always see the same board. The dev agent works in its own git worktree, so its branch checkouts never change the files the review session is reading.

## One-time setup

```bash
cd ~/Documents/Intellitrack
sh scripts/setup-dev-worktree.sh     # creates ../Intellitrack-dev (detached at main), npm ci, dev-only git limits
npx playwright install chromium      # browser for npm run e2e, if not installed yet
```

## Card lifecycle

| Status | Who sets it | Meaning |
|---|---|---|
| `backlog` | (default) | In plan.md §9, not yet specified |
| `ready` | review session | `tasks/<ID>.md` has checkable acceptance criteria; the agent may take it |
| `in_progress` | dev agent | One card at a time, on branch `<id>-<slug>` |
| `blocked` | dev agent | WIP pushed; the question is in `tasks/<ID>.md` under `## Blocked: <date>` |
| `review` | dev agent | Branch pushed, all checks pass, summary in the card's note |
| `done` | review session | Merged to `main` |

Cards are backlog items (`B<n>`, from plan.md) or ad-hoc cards (`X<n>`, a `tasks/X<n>.md` file only). Order: an in-progress card first (resume), then Ready cards by priority. Ad-hoc cards come before planned ones, and `--prio <n>` overrides the order.

```bash
npm run kanban                                   # regenerate kanban.md
npm run kanban -- next                           # what the agent picks next
npm run kanban -- new "Badge turns red" --type ui # scaffold tasks/X<n>.md
npm run kanban -- set X3 ready                   # move a card (needs acceptance criteria)
npm run kanban -- set B2 ready --prio -1         # jump the queue
```

## Run the dev agent

```bash
cd ~/Documents/Intellitrack-dev
claude            # then type /development-start
```

It loops until nothing is Ready, then prints a summary. To stop it earlier, type `/development-stop` in either window. The agent finishes the card it's on (to Review or Blocked, tested and pushed), doesn't take another, and stops. `/development-start` clears the request next time. Each finished card is a pushed branch. Each bottleneck is a Blocked card, and the agent doesn't wait on it: it moves to the next card. `.claude/settings.json` pre-approves the build, test, git and board commands. Force-push and `reset --hard` are denied everywhere. Pushing or merging to `main` is also denied in the dev folder (`.claude/settings.local.json`, written by the setup script).

## Review mode (product manager)

```bash
cd ~/Documents/Intellitrack
claude            # then type /review-start
```

`/review-start` gives a briefing: blocked questions first, then branches waiting for review, the Ready queue, and the next backlog items to refine. After that, say it in plain words:
- **"add a task: …"**: I scaffold `tasks/X<n>.md` (`npm run kanban -- new`) and write the goal, checkable acceptance criteria and out of scope from the code. I show it to you and set it `ready` when you say so.
- **"refine B5"** or **"B3 should also cover forms"**: I write or update the card. Cards that already have a branch get a dated `## Change` section, so the agent sees what moved.
- **"B5 before B3"** or **"do X2 next"**: I re-prioritise (`--prio`, or the plan.md §9 order).
- **"what's blocked?"** then your answer: I append `## Answer` and set the card `ready`. The agent resumes on the same branch.
- **"review B2"**: I diff the branch, run the checks in a throwaway worktree, and go through each criterion. Changes needed go back to the agent as `## Review feedback`.
- **"merge B2"**: I merge to `main`, push, and mark the card `done`.

Review mode doesn't edit product code. A code change you ask for becomes a card.

`/review-stop` commits and pushes the board and plan changes from the session, then lists what's still open.

A card can only be set `ready` once it has at least one real `- [ ]` acceptance criterion. This stops placeholder cards reaching the agent.

## Checks every card must pass

`npm run typecheck && npm test && npm run build`, plus `npm run e2e` for capture, worker or UI changes. The e2e test serves `scripts/e2e/site/` on port 8123 and records it with the built extension in Chrome for Testing. It checks gtag GA4, a server-side GA4 path, Google Ads, unparsed tags, followed new tabs and separate sessions.
