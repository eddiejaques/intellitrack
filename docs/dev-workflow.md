# Working on IntelliTrack: dev agent + review session

Two Claude Code sessions, one board.

```
 review session (main checkout, on main)            dev agent (../Intellitrack-dev worktree)
 ─────────────────────────────────────────           ────────────────────────────────────────
 write tasks/<ID>.md, set card → ready   ──board──▶  /start: next card → branch → build → test
 read Blocked questions, answer, → ready ◀──board──  blocked: WIP pushed + question in tasks/<ID>.md
 review branch, merge when you say so    ◀──git────  review: branch pushed + summary note
```

The board files (`plan.md`, `tasks/`, `kanban.state.json`, `kanban.md`) live in the **main checkout**. `npm run kanban` finds them from either folder, so both sessions always see the same board. The dev agent works in its own git worktree, so its branch checkouts never change the files the review session is reading.

## One-time setup

```bash
cd ~/Documents/Intellitrack
git worktree add ../Intellitrack-dev main
cd ../Intellitrack-dev && npm ci
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
npm run kanban -- set X3 ready                   # move a card
npm run kanban -- set B2 ready --prio -1         # jump the queue
```

## Run the dev agent

```bash
cd ~/Documents/Intellitrack-dev
claude            # then type /start
```

It loops until nothing is Ready, then prints a summary. Each finished card is a pushed branch. Each bottleneck is a Blocked card, and the agent doesn't wait on it: it moves to the next card. `.claude/settings.json` pre-approves the build, test, git and board commands. Force-push, `reset --hard` and pushing to `main` are denied.

## In the review session

Say it in plain words:
- **"add a task: …"**: I write `tasks/X<n>.md` (goal, acceptance criteria, out of scope) and set it to `ready`.
- **"what's blocked?"**: I list the Blocked questions. You answer, I append `## Answer` to the card and set it back to `ready`. The agent resumes on the same branch.
- **"review B2"**: I diff the branch against `main`, rerun the checks and the criteria, and report.
- **"merge B2"**: I merge to `main`, push, set the card to `done` and commit the board.

## Checks every card must pass

`npm run typecheck && npm test && npm run build`, plus `npm run e2e` for capture, worker or UI changes. The e2e test serves `scripts/e2e/site/` on port 8123 and records it with the built extension in Chrome for Testing. It checks gtag GA4, a server-side GA4 path, Google Ads, unparsed tags, followed new tabs and separate sessions.
