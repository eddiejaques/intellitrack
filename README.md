# IntelliTrack

A Chrome (Manifest V3) extension that records the tracking tags fired during a user-driven journey and sends a minimized, redacted log to the user's own LLM for an audit.

- MVP = GA4 only. No backend; bring your own LLM key.
- See [plan.md](plan.md) for scope, architecture, sub-tasks (T0-T6) and backlog.

## Workflow

One branch per sub-task or backlog item (`t1-capture`, `b1-google-ads`, ...), merged to `main` when its "Done when" passes.
