import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import * as lib from "../scripts/kanban-lib.mjs";

const { checkMove, criteria, formatComment, hasCriteria, isApproval, itemToCard, legacyCards, newCardBody, nextCard, normEntry, parseComment, parseTaskFile, parseTitle, pendingAction, tickCriterion } = lib;

/** A project item as the GraphQL query in gh-board.mjs returns it. */
function item(title: string, f: { Status?: string; Prio?: number; Size?: string; Branch?: string } = {}, extra: Record<string, unknown> = {}) {
  const fv = [];
  if (f.Status) fv.push({ name: f.Status, field: { name: "Status" } });
  if (f.Prio !== undefined) fv.push({ number: f.Prio, field: { name: "Prio" } });
  if (f.Size) fv.push({ name: f.Size, field: { name: "Size" } });
  if (f.Branch) fv.push({ text: f.Branch, field: { name: "Branch" } });
  return {
    id: `PVTI_${title}`,
    fieldValues: { nodes: fv },
    content: { number: 7, title, body: "", state: "OPEN", url: "u", labels: { nodes: [{ name: "type:bug" }] }, closedByPullRequestsReferences: { nodes: [] }, ...extra },
  };
}

describe("cards from the GitHub project", () => {
  it("reads ID, title and fields; ignores items without an ID'd issue title", () => {
    expect(parseTitle("B2: dataLayer observer")).toEqual({ id: "B2", title: "dataLayer observer" });
    expect(parseTitle("T-1: Move B2")).toEqual({ id: "T-1", title: "Move B2" });
    expect(parseTitle("fix the badge")).toBeUndefined();
    const c = itemToCard(item("X3: Short findings", { Status: "In progress", Prio: 2, Size: "M", Branch: "x3-short" }));
    expect(c).toMatchObject({ id: "X3", title: "Short findings", number: 7, status: "in_progress", prio: 2, size: "M", branch: "x3-short", type: "bug", merged: false });
    expect(itemToCard(item("no id here"))).toBeUndefined();
    expect(itemToCard({ id: "draft", fieldValues: { nodes: [] }, content: {} })).toBeUndefined();
    expect(itemToCard(item("X1: new")).status).toBe("backlog");
  });

  it("sees a merged PR that closes the issue", () => {
    const c = itemToCard(item("B2: x", { Status: "Review" }, { closedByPullRequestsReferences: { nodes: [{ number: 50, url: "p", merged: true, state: "MERGED", headRefName: "b2-x" }] } }));
    expect(c.merged).toBe(true);
    expect(c.prs[0]).toMatchObject({ number: 50, branch: "b2-x" });
  });

  it("picks an in-progress card first, then Ready by prio, then by id", () => {
    const mk = (id: string, status: string, prio: number) => ({ id, status, prio });
    expect(nextCard([mk("B3", "ready", 6), mk("B2", "ready", 5)]).id).toBe("B2");
    expect(nextCard([mk("X2", "ready", 0), mk("X10", "ready", 0), mk("B2", "ready", 5)]).id).toBe("X2");
    expect(nextCard([mk("B2", "ready", -1), mk("B3", "in_progress", 6)]).id).toBe("B3");
    expect(nextCard([mk("B2", "review", 0), mk("B3", "backlog", 0)])).toBeUndefined();
  });
});

describe("moving cards", () => {
  const card = (o: Record<string, unknown>) => ({ id: "X1", number: 8, status: "backlog", hasCriteria: true, merged: false, ...o });

  it("Done only when the card's PR is merged, even with --force", () => {
    expect(checkMove(card({}), "done")).toMatch(/Done only when its PR \("Closes #8"\) is merged into main/);
    expect(checkMove(card({}), "done", [], { force: true })).toMatch(/merged into main/);
    expect(checkMove(card({ merged: true, status: "review" }), "done")).toBeUndefined();
  });

  it("Ready needs acceptance criteria unless forced", () => {
    expect(checkMove(card({ hasCriteria: false }), "ready")).toMatch(/acceptance criterion/);
    expect(checkMove(card({ hasCriteria: false }), "ready", [], { force: true })).toBeUndefined();
    expect(checkMove(card({}), "ready")).toBeUndefined();
  });

  it("WIP limit 1", () => {
    const others = [{ id: "B2", status: "in_progress" }];
    expect(checkMove(card({}), "in_progress", others)).toMatch(/B2 is already in progress/);
    expect(checkMove(card({ id: "B2", status: "in_progress" }), "in_progress", others)).toBeUndefined();
    expect(checkMove(card({}), "doing")).toMatch(/status must be one of/);
  });

  it("criteria: placeholders and other sections don't count", () => {
    const body = newCardBody();
    expect(hasCriteria(body)).toBe(false);
    expect(hasCriteria(body.replace("- [ ] _Checkable", "- [ ] Badge is red when GA4 is silent\n- [ ] _Checkable"))).toBe(true);
    expect(hasCriteria("## Notes\n- [ ] not criteria")).toBe(false);
  });
});

describe("comments: same GitHub account, so the agent tags its own", () => {
  it("round-trips author and kind", () => {
    const a = formatComment("agent", "blocked", "Which provider key should the test use?");
    expect(a).toBe("**[agent · blocked]**\n\nWhich provider key should the test use?");
    expect(parseComment(a)).toEqual({ author: "agent", kind: "blocked", body: "Which provider key should the test use?" });
    expect(parseComment(formatComment("pm", "feedback", "Rename the tab"))).toEqual({ author: "pm", kind: "feedback", body: "Rename the tab" });
    expect(formatComment("pm", "note", "  plain  ")).toBe("plain");
    expect(parseComment("Looks good **[agent · note]**")).toEqual({ author: "pm", kind: "note", body: "Looks good **[agent · note]**" });
    expect(() => formatComment("pm", "shout", "x")).toThrow(/kind must be/);
    expect(() => formatComment("pm", "note", " ")).toThrow(/needs text/);
  });
});

describe("migration from the old file board", () => {
  const PLAN = `
| **T1** | **Skeleton** | MV3 scaffold | Capture matches | — | Code complete (tests pass) |
| **T2** | Rules | x | Rules flag faults | T1 | Done |

### Prioritization

| Prio | ID | Item | Type | Size | Why at this position | Depends on |
|---|---|---|---|---|---|---|
| 1 | B1 | **Ads** | vendor | M | why ads | MVP |
| 2 | B2 | **dataLayer observer** | capture | M | why dl | MVP |
| — | T-1 | Move B2 | triggered | — | T1 gate fails | — |
`;

  it("reads the old string state and the object state", () => {
    expect(normEntry("review")).toEqual({ status: "review" });
    expect(normEntry(undefined)).toEqual({ status: "backlog" });
    expect(() => normEntry("doing")).toThrow(/unknown status/);
  });

  it("splits a task file into header lines and body", () => {
    expect(parseTaskFile("# X5: dataLayer\nType: rules\nSize: M\nDepends on: B2\n\n## Goal\nx\n")).toEqual({ title: "dataLayer", type: "rules", size: "M", deps: "B2", body: "## Goal\nx\n" });
  });

  it("keeps every card, its status, branch, note, prio and deps", () => {
    const cards = legacyCards(PLAN, { B2: { status: "review", branch: "b2-datalayer", note: "long note" }, X1: { status: "ready", prio: -1 } }, {
      B2: "# B2: dataLayer observer (MAIN world)\nType: capture\nSize: M\n\n## Goal\ndl\n\n## Acceptance criteria\n- [ ] wraps push\n",
      X1: "# X1: Fix the badge\nType: bug\nSize: S\n\n## Acceptance criteria\n- [ ] red\n",
    });
    expect(cards.map((c: { id: string }) => c.id)).toEqual(["T1", "T2", "X1", "B1", "B2", "T-1"]);
    const by = Object.fromEntries(cards.map((c: { id: string }) => [c.id, c]));
    expect(by.T1).toMatchObject({ status: "review", type: "mvp", prio: 0 });
    expect(by.T1.body).toContain("- [ ] Capture matches");
    expect(by.T2).toMatchObject({ status: "done", deps: "T1" });
    expect(by.X1).toMatchObject({ title: "Fix the badge", type: "bug", size: "S", status: "ready", prio: -1 });
    expect(by.B1).toMatchObject({ title: "Ads", status: "backlog", prio: 1, deps: "MVP" });
    expect(by.B1.body).toMatch(/^Depends on: MVP\n\n## Goal\nwhy ads/);
    expect(by.B2).toMatchObject({ title: "dataLayer observer (MAIN world)", branch: "b2-datalayer", note: "long note", status: "review" });
    expect(by.B2.body).toContain("- [ ] wraps push");
    expect(by["T-1"]).toMatchObject({ type: "triggered", prio: 1000 });
  });
});

describe("signals from the PM's comments", () => {
  const OWNER = "board-owner";
  const at = (n: number) => `2026-11-20T10:${String(n).padStart(2, "0")}:00Z`;
  const cm = (login: string, body: string, n: number, on = "issue") => ({ login, body, createdAt: at(n), on });
  const card = (status: string, activity: unknown[]) => ({ id: "B2", status, prio: 5, activity });

  it("recognises approvals and rejects negations", () => {
    for (const t of ["I have reviewed , lets deploy", "Reviewed, let's deploy", "ship it", "LGTM", "approved", "please merge", "**[approve]**\n\nok"]) expect(isApproval(t), t).toBe(true);
    for (const t of ["please don't deploy yet", "do not merge", "not ready to merge", "wait before you deploy", "not approved", "rename the tab", "deployment docs are wrong"]) expect(isApproval(t), t).toBe(false);
  });

  it("only owner comments after the agent's latest comment count", () => {
    const agent = cm(OWNER, "**[agent · review]**\n\nPR #50 is ready", 1);
    expect(pendingAction(card("review", [agent]), OWNER)).toBeUndefined();
    expect(pendingAction(card("review", [cm(OWNER, "lets deploy", 0), agent]), OWNER)).toBeUndefined();
    expect(pendingAction(card("review", [agent, cm(OWNER, "I have reviewed, lets deploy", 2)]), OWNER)?.action).toBe("deploy");
    expect(pendingAction(card("review", [agent, cm(OWNER, "lets deploy", 2, "PR #50")]), OWNER)?.action).toBe("deploy");
    expect(pendingAction(card("review", [agent, cm(OWNER, "rename the tab to Data layer", 2)]), OWNER)?.action).toBe("feedback");
    expect(pendingAction(card("blocked", [agent, cm(OWNER, "use option A", 2)]), OWNER)?.action).toBe("answer");
    // the repo is public: anyone else's "lets deploy" is ignored
    expect(pendingAction(card("review", [agent, cm("someone-else", "lets deploy", 2)]), OWNER)).toBeUndefined();
    // comments on Ready / Backlog cards are notes, not signals
    expect(pendingAction(card("ready", [cm(OWNER, "lets deploy", 2)]), OWNER)).toBeUndefined();
  });

  it("next: resume, then deploy, answer, feedback, then Ready", () => {
    const mk = (id: string, status: string, prio: number, action?: string) => ({ id, status, prio, pending: action && { action } });
    expect(nextCard([mk("B3", "ready", 0), mk("B2", "review", 5, "feedback"), mk("B1", "review", 4, "deploy")])).toMatchObject({ id: "B1", action: "deploy" });
    expect(nextCard([mk("B3", "ready", 0), mk("B2", "review", 5, "feedback"), mk("X1", "blocked", 9, "answer")])).toMatchObject({ id: "X1", action: "answer" });
    expect(nextCard([mk("B3", "ready", 0), mk("B2", "review", 5, "feedback")])).toMatchObject({ id: "B2", action: "feedback" });
    expect(nextCard([mk("B3", "ready", 0), mk("B2", "review", 5)])).toMatchObject({ id: "B3", action: "start" });
    expect(nextCard([mk("B1", "review", 4, "deploy"), mk("B4", "in_progress", 7)])).toMatchObject({ id: "B4", action: "resume" });
  });

  it("reads issue and PR comments from the project item", () => {
    const node = {
      id: "PVTI_1", fieldValues: { nodes: [{ name: "Review", field: { name: "Status" } }] },
      content: {
        number: 17, title: "B2: dataLayer", body: "", state: "OPEN", url: "u", labels: { nodes: [] },
        comments: { nodes: [{ author: { login: OWNER }, body: "**[agent · review]**\n\nready", createdAt: at(1) }] },
        closedByPullRequestsReferences: { nodes: [{ number: 50, url: "p", merged: false, state: "OPEN", headRefName: "b2-x", comments: { nodes: [{ author: { login: OWNER }, body: "lets deploy", createdAt: at(3) }] } }] },
      },
    };
    const c = itemToCard(node, OWNER);
    expect(c.activity.map((m: { on: string }) => m.on)).toEqual(["issue", "PR #50"]);
    expect(c.pending.action).toBe("deploy");
    expect(itemToCard(node).pending).toBeUndefined();
  });
});

describe("ticking acceptance criteria", () => {
  const body = "## Goal\n- [ ] not a criterion\n\n## Acceptance criteria\n- [ ] first\n- [x] second\n  - [ ] nested third\n\n## Notes\n- [ ] note";
  it("numbers only the criteria and ticks one in place", () => {
    expect(criteria(body).map((c: { n: number; done: boolean; text: string }) => [c.n, c.done, c.text])).toEqual([[1, false, "first"], [2, true, "second"], [3, false, "nested third"]]);
    const ticked = tickCriterion(body, 1);
    expect(ticked).toContain("- [x] first");
    expect(ticked).toContain("## Goal\n- [ ] not a criterion");
    expect(tickCriterion(body, 2, false)).toContain("- [ ] second");
    expect(() => tickCriterion(body, 9)).toThrow(/no acceptance criterion 9/);
  });
});
