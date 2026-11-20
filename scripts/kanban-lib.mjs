// Pure board logic for scripts/kanban.mjs and scripts/gh-board.mjs (tested in tests/kanban.test.ts).
//
// The board is a GitHub Project. A card is an issue on it whose title starts with its ID
// ("B2: dataLayer observer"); its column is the project's Status field, and Prio, Size and Branch
// are project fields. The type is a `type:<name>` label. Comments are issue comments.
//
// The PM and the dev agent post as the same GitHub account, so the agent marks its comments
// "**[agent · <kind>]**" on the first line, and the PM's answer / feedback comments may carry
// "**[answer]**" / "**[feedback]**".

export const STATUSES = ["backlog", "ready", "in_progress", "blocked", "review", "done"];
export const STATUS_NAMES = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" };
const STATUS_BY_NAME = Object.fromEntries(Object.entries(STATUS_NAMES).map(([k, v]) => [v.toLowerCase(), k]));
export const KINDS = ["note", "answer", "feedback", "blocked", "change", "review"];

/** "B2: dataLayer observer" -> { id: "B2", title: "dataLayer observer" }; undefined for other titles. */
export function parseTitle(t = "") {
  const m = /^\s*([A-Z]+-?\d+)\s*:\s*(.+)$/.exec(t);
  return m ? { id: m[1], title: m[2].trim() } : undefined;
}

/** One project item (GraphQL node from gh-board.mjs) -> card, or undefined if it isn't an ID'd issue. */
export function itemToCard(node) {
  const c = node?.content;
  if (!c?.number) return undefined;
  const t = parseTitle(c.title);
  if (!t) return undefined;
  const f = {};
  for (const v of node.fieldValues?.nodes ?? []) if (v?.field?.name) f[v.field.name] = v.name ?? v.number ?? v.text;
  const labels = (c.labels?.nodes ?? []).map((l) => l.name);
  const prs = (c.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({ number: p.number, url: p.url, merged: !!p.merged, state: p.state, branch: p.headRefName }));
  return {
    id: t.id, title: t.title, number: c.number, url: c.url, itemId: node.id, state: c.state, body: c.body ?? "",
    status: STATUS_BY_NAME[String(f.Status ?? "").toLowerCase()] ?? "backlog",
    prio: typeof f.Prio === "number" ? f.Prio : 1000,
    size: f.Size ?? "S", branch: f.Branch || undefined,
    type: labels.find((l) => l.startsWith("type:"))?.slice(5) ?? "task",
    prs, merged: prs.some((p) => p.merged),
    hasCriteria: hasCriteria(c.body ?? ""),
  };
}

const byPrio = (a, b) => a.prio - b.prio || a.id.localeCompare(b.id, "en", { numeric: true });

/** The card the dev agent should work on: one already in progress first (resume), else the top Ready card. */
export function nextCard(cards) {
  const doing = cards.find((c) => c.status === "in_progress");
  if (doing) return doing;
  return cards.filter((c) => c.status === "ready").sort(byPrio)[0];
}

export const sortCards = (cards) => [...cards].sort(byPrio);

/**
 * Can a card move to this status? Returns an error message, or undefined.
 * - Done only happens through a PR merged into main (never forced).
 * - Ready needs at least one real acceptance criterion.
 * - WIP limit 1.
 */
export function checkMove(card, status, cards = [], { force = false } = {}) {
  if (!STATUSES.includes(status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (status === "done" && !card.merged) {
    return `${card.id} can't be Done: a card is Done only when its PR ("Closes #${card.number}") is merged into main.`;
  }
  if (force) return undefined;
  if (status === "ready" && card.status !== "ready" && !card.hasCriteria) {
    return `${card.id} can't be Ready yet: the issue needs at least one acceptance criterion ("- [ ] …") under "## Acceptance criteria". Use --force to override.`;
  }
  if (status === "in_progress") {
    const other = cards.find((c) => c.status === "in_progress" && c.id !== card.id);
    if (other) return `WIP limit is 1: ${other.id} is already in progress`;
  }
  return undefined;
}

/** Comment text as posted: the agent's comments (and the PM's tagged ones) carry a tag on line 1. */
export function formatComment(author, kind, body) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const text = String(body ?? "").trim();
  if (!text) throw new Error("a comment needs text");
  if (author === "agent") return `**[agent · ${kind}]**\n\n${text}`;
  return kind === "note" ? text : `**[${kind}]**\n\n${text}`;
}

/** Read the tag back: { author: "agent" | "pm", kind, body }. Untagged comments are the PM's notes. */
export function parseComment(text = "") {
  const m = /^\*\*\[(?:(agent) · )?([a-z]+)\]\*\*[ \t]*\n?/.exec(text);
  if (!m) return { author: "pm", kind: "note", body: text.trim() };
  if (!m[1] && m[2] === "agent") return { author: "agent", kind: "note", body: text.slice(m[0].length).trim() };
  return { author: m[1] ? "agent" : "pm", kind: KINDS.includes(m[2]) ? m[2] : "note", body: text.slice(m[0].length).trim() };
}

/** True when the body's "Acceptance criteria" section has at least one real (non-placeholder) checkbox. */
export function hasCriteria(text = "") {
  const sec = text.split(/^## /m).find((p) => /^Acceptance criteria/i.test(p)) ?? "";
  return sec.split("\n").some((l) => /^\s*- \[[ x]\]\s+(?!_)\S/.test(l));
}

/** Body skeleton for a new card. The PM fills Goal and Acceptance criteria before moving it to Ready. */
export function newCardBody() {
  return "## Goal\n_Why this matters and for whom._\n\n## Acceptance criteria\n- [ ] _Checkable statement (a test, an e2e check, or something visible in the UI)._\n\n## Out of scope\n- \n\n## Notes\n";
}

// ---- The old file board (plan.md tables + tasks/*.md + kanban.state.json), read once by the migration ----

const cells = (line) => line.split("|").slice(1, -1).map((c) => c.trim());
const clean = (t) => t.replace(/\*\*/g, "").replace(/`/g, "");

export function normEntry(v) {
  if (v == null) return { status: "backlog" };
  const e = typeof v === "string" ? { status: v } : { ...v };
  if (!STATUSES.includes(e.status)) throw new Error(`unknown status "${e.status}" (use ${STATUSES.join(", ")})`);
  return e;
}

/** A tasks/<ID>.md split into its header lines (Type, Size, Depends on) and the rest. */
export function parseTaskFile(text) {
  const lines = text.split("\n");
  const meta = {};
  let i = /^#\s/.test(lines[0] ?? "") ? 1 : 0;
  const head = /^#\s+(?:[A-Z]+-?\d+)?\s*[:\-–]?\s*(.+)$/.exec(lines[0] ?? "");
  for (; i < lines.length; i++) {
    const m = /^(Type|Size|Depends on):\s*(.*)$/i.exec(lines[i]);
    if (!m) break;
    meta[m[1].toLowerCase()] = m[2].trim();
  }
  while (i < lines.length && !lines[i].trim()) i++;
  return { title: head?.[1]?.trim(), type: meta.type, size: meta.size, deps: meta["depends on"], body: lines.slice(i).join("\n").trimEnd() + "\n" };
}

/**
 * Every card of the old file board, in creation order (MVP, then ad-hoc, then by plan rank):
 * { id, title, type, size, status, prio, branch?, note?, deps, body }.
 */
export function legacyCards(planText, rawState = {}, taskFiles = {}) {
  const state = Object.fromEntries(Object.entries(rawState).map(([k, v]) => [k, normEntry(v)]));
  const out = [];
  const depsLine = (d) => (d && d !== "—" ? `Depends on: ${d}\n\n` : "");

  planText.split("\n").filter((l) => /^\| \*\*T\d\*\* \|/.test(l)).forEach((l, n) => {
    const [id, name, what, done, deps, status] = cells(l).map(clean);
    const col = /^done/i.test(status) ? "done" : /^in progress/i.test(status) ? "in_progress" : /^(code complete|repo initialized)/i.test(status) ? "review" : "backlog";
    out.push({ id, title: name, type: "mvp", size: "M", status: col, prio: n, deps,
      body: `${depsLine(deps)}## Scope\n${what}\n\n## Gate (done when)\n- [ ] ${done}\n\n## Status in plan.md\n${status}\n` });
  });

  const at = planText.indexOf("### Prioritization");
  const rows = (at >= 0 ? planText.slice(at) : "").split("\n").filter((l) => /^\| (\d+|—) \| /.test(l)).map((l) => cells(l).map(clean));
  const planned = rows.map(([prio, id, item, type, size, why, deps]) => ({ prio, id, item, type, size, why, deps }));
  const known = new Set(planned.map((b) => b.id));
  const adhoc = Object.keys(taskFiles).filter((id) => /^X\d+$/.test(id) && !known.has(id))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((id) => ({ id, prio: "0" }));

  for (const b of [...adhoc, ...planned]) {
    const task = taskFiles[b.id] ? parseTaskFile(taskFiles[b.id]) : undefined;
    const s = state[b.id] ?? { status: "backlog" };
    const triggered = b.prio === "—";
    const deps = task?.deps ?? b.deps ?? "";
    const body = triggered
      ? `Trigger: ${b.why}\n\nThis card skips the queue only when the trigger fires.\n`
      : task
        ? depsLine(deps) + task.body
        : `${depsLine(deps)}## Goal\n${b.why ?? ""}\n\n## Acceptance criteria\n- [ ] _To be written before this card is Ready._\n`;
    const size = task?.size ?? b.size;
    out.push({
      id: b.id, title: task?.title ?? b.item ?? b.id,
      type: (triggered ? "triggered" : task?.type ?? b.type ?? "task").toLowerCase().replace(/[^a-z-]/g, "") || "task",
      size: /^[SML]$/.test(size ?? "") ? size : "M",
      status: s.status, prio: s.prio ?? (triggered ? 1000 : Number(b.prio)), branch: s.branch, note: s.note, deps, body,
    });
  }
  return out;
}
