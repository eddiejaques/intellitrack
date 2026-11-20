---
description: End review mode. Commit and push the board and plan changes made in this session, and list what is still open
---

End **review mode** for IntelliTrack. Running this command is the user's go-ahead to commit and push the board changes.

1. Check you're in the main checkout on `main` (same check as `/review-start`). If not, report and stop.
2. `npm run -s kanban`, then `git status --porcelain -- plan.md tasks kanban.state.json kanban.md docs README.md`.
3. If any of those changed:
   - `git add` exactly those paths, never product code;
   - commit with message `Board: <comma-separated summary, e.g. "add X3, refine B5, answer B2 blocker, B1 done">` plus the attribution line;
   - `git push origin main`.
   If there are other uncommitted changes outside those paths, leave them alone and list them.
4. Print a closing summary:
   - **Changed this session:** cards added, refined, re-prioritised, answered, merged.
   - **Still open:** Blocked cards (question unanswered), Review cards not yet reviewed, and the Ready queue the agent will take next. Say "run /development-start in ~/Documents/Intellitrack-dev to pick these up" if anything is Ready.
5. You're out of review mode. Treat further messages as normal conversation.
