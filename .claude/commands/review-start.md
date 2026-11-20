---
description: Review mode (product manager). Brief me on the board, then add and refine tasks, answer blockers, review and merge PRs
---

You are in **review mode** for IntelliTrack. The user is the product manager. Follow `CLAUDE.md`. In this mode you **shape the work, you don't build it**: product code changes go onto cards for the dev agent (`/development-start`). Only cards (GitHub issues), `plan.md` and docs are edited here. Stay in this mode until the user runs `/review-stop`.

The board is a GitHub Project (`npm run -s kanban` prints its URL). Each card is an issue titled `<ID>: <title>`, its column is the Status field, and Prio, Size and Branch are fields. The user can also work directly on the board in the browser: create issues, comment, drag cards. The dev agent reacts to their comments: on a Review card, an approval like "I have reviewed, let's deploy" makes the agent merge the PR itself; any other comment is feedback; a comment on a Blocked card is the answer.

## 0. Preflight
- `git rev-parse --show-toplevel` must equal `npm run -s kanban -- dir` (the main checkout). If not: "Run /review-start from the main checkout (~/Documents/Intellitrack)." Then stop.
- `git branch --show-current` must be `main`. If it isn't and the tree is clean, `git checkout main`. If there are uncommitted changes, report them and stop.
- `git pull --ff-only` so local `main` matches merged PRs.

## 1. Briefing
Run `npm run -s kanban` and `gh pr list --state open`, then give a short briefing, most urgent first:
1. **Blocked:** for each card, `npm run -s kanban -- show <ID>` and give the latest `agent · blocked` comment: the question and the options.
2. **Waiting for review:** each card in Review with its PR (number, title, `gh pr view <n> --json additions,deletions,commits`), and the agent's latest note.
3. **Ready queue:** in the order the agent will take it (`npm run -s kanban -- next` is first). Flag any without acceptance criteria.
4. **Next to refine:** the top 3 Backlog cards (by Prio) whose criteria are still placeholders.

End with one line: "What do you want to do? (add / refine / prioritise / answer / review / merge)".

## 2. Requests in this mode

**Add a task**, e.g. "add a task: the badge should turn red when GA4 is silent"
1. Write the body to a scratchpad file:
   - `## Goal`: who it's for and why;
   - `## Acceptance criteria`: checkable `- [ ]` items, each provable by a unit test, an e2e check or something visible in a named page;
   - `## Out of scope`;
   - `## Notes`: the files involved, found by reading the code;
   - a `Depends on: <IDs>` line at the top if it needs another card first.
   Always end the criteria with "`npm run typecheck && npm test && npm run build` (and `npm run e2e` if capture/UI) pass".
2. `npm run -s kanban -- new "<short title>" --type <bug|feature|ui|capture|vendor|rules|docs> --size <S|M|L> --body-file <file>` (add `--ready` if the user said "ready").
3. Show the card (issue link). Ask only what you can't infer: ambiguity in the goal, or a choice between two real options.
4. Move it to Ready when the user says so: `npm run -s kanban -- set <ID> ready`. `--prio -1` puts it first.

**Refine an existing task**, e.g. "refine B5", or "B3 should also cover forms"
- No branch yet: rewrite the issue body (`gh issue edit <n> --body-file <file>`), using the plan.md §9 row and the §10 vendor notes.
- Has a branch (it was blocked or reviewed): leave the body and add `npm run -s kanban -- comment <ID> --kind change --body-file <file>`, so the agent sees what changed.
- Changes to scope, size or order in the plan itself: also edit the plan.md §9 table row.

**Prioritise**, e.g. "B5 before B3", "do X2 next"
- `npm run -s kanban -- set <ID> <status> --prio <n>` (lower goes first). The board's Prio field is the order the agent uses.

**Answer a blocker**
- `npm run -s kanban -- comment <ID> --kind answer "<the user's decision in their words, plus the concrete consequence for the code>"`
- Then `npm run -s kanban -- set <ID> ready`. The agent resumes on the card's existing branch.

**Review a PR**, e.g. "review B2"
1. `gh pr view <n>` and `gh pr diff <n>`, and read the diff.
2. Run the checks in a throwaway worktree, never by checking out here:
   ```bash
   git fetch origin -q
   git worktree add --detach <scratchpad>/review-<id> origin/<branch>
   cd <scratchpad>/review-<id> && npm ci && npm run typecheck && npm test && npm run build
   ```
   Add `npm run e2e` if capture/UI changed. Then `git worktree remove` it.
3. Report: each acceptance criterion as met/not met with evidence, bugs or risks found in the diff, and a verdict (merge / changes needed).
4. If the user wants changes: `npm run -s kanban -- comment <ID> --kind feedback --body-file <file>` with the specific changes as `- [ ]` items, then `npm run -s kanban -- set <ID> ready`. The agent picks it up on the same branch and PR. (GitHub doesn't allow "request changes" on your own PR, so the feedback goes on the card.)

**Merge**: only when the user explicitly says "merge <ID>" (or they comment the approval on the card and let the dev agent deploy it)
- `gh pr merge <n> --merge` (a merge commit, like `--no-ff`). The PR's `Closes #<issue>` closes the issue.
- `git pull --ff-only`, then `npm test && npm run build` on `main`.
- `npm run -s kanban -- set <ID> done`. The CLI refuses unless the PR is merged: **a card is Done only when its PR is merged into main.**

**Anything else** (questions about the product, the plan or the code): answer it normally, read-only.

Never edit product code in `extension/`, `tests/` or `scripts/` in this mode. If the user asks for a code change, offer to turn it into a card. Never close an issue by hand to finish a card.
