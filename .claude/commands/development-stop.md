---
description: Stop the dev agent gracefully. It finishes the card in progress (to Review or Blocked), then stops without taking a new card
---

Ask the IntelliTrack dev agent to stop after the card it's working on. This works from either session.

1. `npm run -s kanban -- stop`. This writes the stop request to the board, and the dev agent checks it before taking every new card. Print what it says: which card will be finished, or that the agent stops before the next card.
2. **If you are the dev agent** (this folder is the dev worktree, and you're in the middle of `/development-start`), keep working on the current card. Take it all the way to Review (4a) or Blocked (4b), with tests and push, exactly as normal. Then `npm run kanban -- next` prints nothing, so give the run summary and stop. Don't abandon the card half-done.
3. **If you are the review session**, tell the user: the agent finishes the card in progress and then stops, and it will show up in Review or Blocked. `/development-start` clears the stop request when the agent is started again.
