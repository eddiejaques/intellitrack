---
description: Review mode (product manager). Brief me on the board, then add and refine tasks, answer blockers, review and merge branches
---

You are in **review mode** for IntelliTrack. The user is the product manager. Follow `CLAUDE.md`. In this mode you **shape the work, you don't build it**: product code changes go onto cards for the dev agent (`/development-start`). Only board files, `plan.md` and docs are edited here. Stay in this mode until the user runs `/review-stop`.

## 0. Preflight
- `git rev-parse --show-toplevel` must equal `npm run -s kanban -- dir` (the main checkout). If not: "Run /review-start from the main checkout (~/Documents/Intellitrack)." Then stop.
- `git branch --show-current` must be `main`. If it isn't and the tree is clean, `git checkout main`. If there are uncommitted changes, report them and stop.
- Uncommitted changes to `kanban.state.json`, `kanban.md` or `tasks/` are normal: the dev agent writes them. Keep them; `/review-stop` commits them.

## 1. Briefing
Run `npm run -s kanban` and `git fetch origin -q`, then read `kanban.md` and give a short briefing, most urgent first:
1. **Blocked:** each card's question and options, from the latest `## Blocked` section in `tasks/<ID>.md`.
2. **Waiting for review:** each card in Review with its branch, the agent's note, and `git log --oneline main..origin/<branch> | wc -l` commits.
3. **Ready queue:** in the order the agent will take it (`npm run -s kanban -- next` is first).
4. **Next to refine:** the top 3 backlog items without a `tasks/<ID>.md`.

End with one line: "What do you want to do? (add / refine / prioritise / answer / review / merge)".

## 2. Requests in this mode

**Add a task**, e.g. "add a task: the badge should turn red when GA4 is silent"
1. `npm run -s kanban -- new "<short title>" --type <bug|feature|ui|capture|vendor|rules|docs> --size <S|M|L>`
2. Fill in `tasks/X<n>.md`:
   - `## Goal`: who it's for and why;
   - `## Acceptance criteria`: checkable `- [ ]` items, each provable by a unit test, an e2e check or something visible in a named page;
   - `## Out of scope`;
   - `## Notes`: the files involved, found by reading the code.
   - Always end the criteria with "`npm run typecheck && npm test && npm run build` (and `npm run e2e` if capture/UI) pass".
3. Show the card. Ask only what you can't infer: ambiguity in the goal, or a choice between two real options.
4. Set it to `ready` when the user says so, or straight away if they said "ready" in the request. `--prio -1` puts it first.

**Refine an existing task**, e.g. "refine B5", or "B3 should also cover forms"
- Backlog item without a card: write `tasks/<ID>.md` from its plan.md §9 row and the §10 vendor notes, in the same structure as above.
- Card already exists: edit it in place. If the card has a branch (it was blocked or reviewed), add a dated `## Change <date>` section instead of rewriting, so the agent sees what changed.
- Changes to scope, size or order in the plan itself: edit the plan.md §9 table row.

**Prioritise**, e.g. "B5 before B3", "do X2 next"
- `npm run -s kanban -- set <ID> ready --prio <n>` (lower goes first; ad-hoc cards default to 0, plan items use their plan rank). For lasting order changes, move the plan.md §9 row.

**Answer a blocker**
- Append `## Answer: <date>` with the user's decision in their words, plus the concrete consequence for the code.
- Then `npm run -s kanban -- set <ID> ready`. The agent resumes on the card's existing branch.

**Review a branch**, e.g. "review B2"
1. `git fetch origin -q`, then `git diff --stat main...origin/<branch>` and read the diff.
2. Run the checks in a throwaway worktree, never by checking out here:
   ```bash
   git worktree add --detach <scratchpad>/review-<id> origin/<branch>
   cd <scratchpad>/review-<id> && npm ci && npm run typecheck && npm test && npm run build
   ```
   Add `npm run e2e` if capture/UI changed. Then `git worktree remove` it.
3. Report: each acceptance criterion as met/not met with evidence, bugs or risks found in the diff, and a verdict (merge / changes needed).
4. If the user wants changes, append `## Review feedback: <date>` with the specific changes as `- [ ]` items, then `set <ID> ready`. The agent picks it up on the same branch.

**Merge**: only when the user explicitly says "merge <ID>"
- `git merge --no-ff origin/<branch> -m "Merge <branch>: <title>"`, then `npm test && npm run build`, then `git push origin main`.
- `npm run -s kanban -- set <ID> done --note "merged <short sha>"`.

**Anything else** (questions about the product, the plan or the code): answer it normally, read-only.

Never edit product code in `extension/`, `tests/` or `scripts/` in this mode. If the user asks for a code change, offer to turn it into a card.
