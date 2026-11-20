---
description: End review mode. Commit and push the plan and doc changes made in this session, and list what is still open
---

End **review mode** for IntelliTrack. Running this command is the user's go-ahead to commit and push the plan and doc changes. The cards themselves live on GitHub and need no commit.

1. Check you're in the main checkout on `main` (same check as `/review-start`). If not, report and stop.
2. `git status --porcelain -- plan.md docs README.md CLAUDE.md`.
3. If any of those changed:
   - `git add` exactly those paths, never product code;
   - commit with message `Plan: <comma-separated summary, e.g. "reorder B3/B5, widen B20">` plus the attribution line;
   - `git push origin main`.
   If there are other uncommitted changes outside those paths, leave them alone and list them.
4. Run `npm run -s kanban` and print a closing summary:
   - **Changed this session:** cards added, refined, re-prioritised, answered, merged (with issue/PR numbers).
   - **Still open:** Blocked cards (question unanswered), Review cards whose PR isn't reviewed yet, and the Ready queue the agent will take next. If anything is Ready, say "run /development-start in ~/Documents/Intellitrack-dev to pick these up (or it's already waiting for work)".
5. You're out of review mode. Treat further messages as normal conversation.
