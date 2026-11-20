---
description: Dev agent. Work through the Ready cards on the kanban board one at a time (branch, build, test, push, or block)
---

You are the IntelliTrack **dev agent**. Follow `CLAUDE.md`. Work through the board until nothing is Ready, then stop. Don't ask the user questions mid-run: anything you can't settle yourself becomes a **blocker** on the card, and you move on.

## 0. Preflight (once)
- Run `git rev-parse --show-toplevel`. If the result is the main checkout (`npm run kanban -- dir` prints the same path), **stop**: "Run /development-start from the dev worktree (../Intellitrack-dev), not the main checkout." Branch checkouts here would change the review session's files.
- Run `git status --porcelain`. If there are uncommitted changes that don't belong to an in-progress card's branch, stop and report them.
- Run `npm ci` if `node_modules` is missing.

## 1. Pick a card
`main` is checked out in the review session's folder, and git doesn't allow one branch in two worktrees. So **never `git checkout main` here**. Use `git checkout --detach main` to sit on main, and cut branches from the local `main` ref. The review session keeps that ref up to date: worktrees share it, so its merges are visible here immediately.

1. `git fetch origin -q && git checkout --detach main`
2. `npm run kanban -- next`. It prints `ID<TAB>title`, or nothing.
   - Nothing: report the run summary (step 5) and stop.
3. Read `<board dir>/tasks/<ID>.md` (`npm run kanban -- dir` gives the board dir), including any `## Answer`, `## Change` or `## Review feedback` sections. The newest section wins. Read the relevant parts of `plan.md` for that ID.
   - If there's no task file, or the acceptance criteria aren't checkable, block the card right away (step 4b) and ask for them.
4. Start or resume the card. Look up its `branch` in `<board dir>/kanban.state.json`.
   - **It has a branch** (resuming after a crash, an answered blocker or review feedback): `git checkout <branch>`, then `git merge main` if main moved on. Continue from where the code is, and address the newest Answer/Change/Feedback section first.
   - **No branch:** `git checkout -b <id>-<slug> main`.
   - Then `npm run kanban -- set <ID> in_progress --branch <branch>`.

## 2. Build it
- Implement the acceptance criteria, smallest coherent change first. Write tests in `tests/` alongside the code.
- Commit in small steps on the card's branch.
- Stay inside the card. Note anything else you notice in the summary rather than fixing it.

## 3. Verify
- `npm run typecheck && npm test && npm run build`
- `npm run e2e` if you touched capture, the background worker, or UI pages. Add an e2e check when the criteria ask for one.
- Go through the acceptance criteria one by one and tick each in your summary with the evidence (test name, e2e check, screenshot path).

## 4a. Done → Review
- `git push -u origin <branch>`
- `npm run kanban -- set <ID> review --note "<one paragraph: what changed, how it was verified, anything the reviewer should look at>"`
- Then go back to step 1.

## 4b. Bottleneck → Blocked
Block when:
- the criteria are unclear or contradict the code;
- you need the user's API keys, a login or a real site that blocks automation;
- a product or design decision isn't yours to make;
- verification still fails after three honest attempts at a fix;
- the change would break a hard limit in `CLAUDE.md`.

Then:
1. Commit the work in progress on the branch (`WIP: <ID> blocked: <reason>`) and `git push -u origin <branch>`.
2. Append to `<board dir>/tasks/<ID>.md`:
   ```
   ## Blocked: <YYYY-MM-DD>
   - <the one question you need answered, first line, specific>
   - Tried: <what you tried and what happened>
   - Branch: <branch> (state of the code)
   - Options: <A / B with your recommendation>, if it's a decision
   ```
3. `npm run kanban -- set <ID> blocked --note "<the question, short>"`
4. `git checkout --detach main`, then go back to step 1 for the next card.

## 5. Run summary (when nothing is Ready)
Print a short table: card, result (review/blocked), branch, one line each. Then stop.

Never merge to `main`, force-push, or edit another card's branch.
