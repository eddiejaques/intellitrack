// Pure board logic for scripts/kanban.mjs and scripts/gh-board.mjs (tested in tests/kanban.test.ts).
//
// The board is a GitHub Project. A card is an issue on it whose title starts with its ID
// ("B2: dataLayer observer"); its column is the project's Status field, and Prio, Size and Branch
// are project fields. The type is a `type:<name>` label. Comments are issue comments.
//
// The PM and the dev agent post as the same GitHub account, so the agent marks its comments
// "**[agent · <kind>]**" on the first line, and the PM's answer / feedback comments may carry
// "**[answer]**" / "**[feedback]**" / "**[approve]**".
//
// The PM steers the agent from the browser by commenting. Only comments from the board owner's
// GitHub account count (the repo is public, so anyone can comment); everyone else is ignored.
// A new PM comment after the agent's latest comment is a signal (see pendingAction):
//   Review card + approval ("I have reviewed, let's deploy")  -> the agent merges the PR (deploy)
//   Review card + anything else                               -> review feedback: rework on the branch
//   Blocked card + any comment                                -> the answer: resume on the branch
//   Backlog card + any comment (or never refined yet)         -> refine: the agent rewrites the spec only
//   Blocked card the agent asked a "clarify" question on      -> refine again (not "answer"): spec only
//
// Backlog cards are refined, never built: the agent drafts a short Goal / Acceptance criteria /
// Out of scope / Notes in the issue body and stops there. If the scope is unclear, it doesn't guess:
// it posts a "[agent · clarify]" question and moves the card to Blocked. Your answer sends it back to
// refinement, and a refined card goes back to Backlog. Only the PM moves a card to Ready, and only Ready cards get
// a branch or code.

export const STATUSES = ["backlog", "ready", "in_progress", "blocked", "review", "done"];
export const STATUS_NAMES = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" };
const STATUS_BY_NAME = Object.fromEntries(Object.entries(STATUS_NAMES).map(([k, v]) => [v.toLowerCase(), k]));
export const KINDS = ["note", "answer", "feedback", "blocked", "change", "review", "approve", "progress", "refine", "clarify"];

/** "B2: dataLayer observer" -> { id: "B2", title: "dataLayer observer" }; undefined for other titles. */
export function parseTitle(t = "") {
  const m = /^\s*([A-Z]+-?\d+)\s*:\s*(.+)$/.exec(t);
  return m ? { id: m[1], title: m[2].trim() } : undefined;
}

/** One project item (GraphQL node from gh-board.mjs) -> card, or undefined if it isn't an ID'd issue. */
export function itemToCard(node, owner) {
  const c = node?.content;
  if (!c?.number) return undefined;
  const t = parseTitle(c.title);
  if (!t) return undefined;
  const f = {};
  for (const v of node.fieldValues?.nodes ?? []) if (v?.field?.name) f[v.field.name] = v.name ?? v.number ?? v.text;
  const labels = (c.labels?.nodes ?? []).map((l) => l.name);
  const prNodes = c.closedByPullRequestsReferences?.nodes ?? [];
  const prs = prNodes.map((p) => ({ number: p.number, url: p.url, merged: !!p.merged, state: p.state, branch: p.headRefName }));
  // issue and PR comments together, oldest first
  const activity = [
    ...(c.comments?.nodes ?? []).map((m) => ({ ...m, on: "issue" })),
    ...prNodes.flatMap((p) => (p.comments?.nodes ?? []).map((m) => ({ ...m, on: `PR #${p.number}` }))),
  ].map((m) => ({ login: m.author?.login ?? "", body: m.body ?? "", createdAt: m.createdAt ?? "", on: m.on }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const card = {
    id: t.id, title: t.title, number: c.number, url: c.url, itemId: node.id, state: c.state, body: c.body ?? "",
    status: STATUS_BY_NAME[String(f.Status ?? "").toLowerCase()] ?? "backlog",
    prio: typeof f.Prio === "number" ? f.Prio : 1000,
    size: f.Size ?? "S", branch: f.Branch || undefined,
    type: labels.find((l) => l.startsWith("type:"))?.slice(5) ?? "task",
    prs, merged: prs.some((p) => p.merged),
    hasCriteria: hasCriteria(c.body ?? ""),
    specMissing: checkSpec(c.body ?? ""),
    activity,
  };
  card.pending = pendingAction(card, owner);
  card.refine = needsRefine(card, owner);
  return card;
}

/**
 * An approval to deploy (merge the PR into main): an explicit `**[approve]**` tag, or plain words
 * like "I have reviewed, let's deploy", "ship it", "merge it", "LGTM", "approved". A negation
 * ("don't deploy", "not ready to merge") is never an approval.
 */
export function isApproval(text = "") {
  const t = String(text).toLowerCase();
  if (/^\*\*\[approve\]\*\*/.test(t)) return true;
  if (/\b(don'?t|do not|not|never|no|hold|wait|before)\b[^.!?\n]{0,30}\b(deploy|merge|ship)/.test(t)) return false;
  if (/\b(not|un|isn'?t|wasn'?t)\s*approved\b/.test(t)) return false;
  return /\b(let'?s|lets|go ahead and|please|ok(ay)? to|good to|ready to)\s+(deploy|merge|ship)\b/.test(t)
    || /\b(ship|merge|deploy) it\b/.test(t) || /\blgtm\b/.test(t) || /\bapproved?\b/.test(t);
}

/**
 * What the PM's newest comments ask the agent to do, or undefined. Only comments by `owner` that
 * came after the agent's latest comment count; the agent's own comments are tagged "[agent · …]".
 *   { action: "deploy" | "feedback" | "answer", comments: [...] }
 */
export function pendingAction(card, owner) {
  if (!owner || !["review", "blocked"].includes(card.status)) return undefined;
  const mine = (card.activity ?? []).filter((m) => m.login === owner);
  let last = -1;
  mine.forEach((m, i) => { if (parseComment(m.body).author === "agent") last = i; });
  const fresh = mine.slice(last + 1);
  if (!fresh.length) return undefined;
  if (card.status === "blocked") {
    // a clarify question was asked while refining a Backlog card: the answer means "refine again"
    if (parseComment(mine[last]?.body).kind === "clarify") return undefined;
    return { action: "answer", comments: fresh };
  }
  return { action: fresh.some((m) => isApproval(m.body)) ? "deploy" : "feedback", comments: fresh };
}

/**
 * Should the agent refine this card's spec? True for an open card without a branch (not
 * `type:triggered`) that is either
 *   - in Backlog, and the agent has never refined it or asked about it, or the PM commented after
 *     the agent's latest comment (the PM's way to ask for another pass); or
 *   - Blocked on the agent's "clarify" question, and the PM has answered it.
 */
export function needsRefine(card, owner) {
  if (!owner || card.branch || card.state === "CLOSED" || card.type === "triggered") return false;
  const mine = (card.activity ?? []).filter((m) => m.login === owner);
  let last = -1;
  mine.forEach((m, i) => { if (parseComment(m.body).author === "agent") last = i; });
  const answered = last >= 0 && last < mine.length - 1;
  if (card.status === "blocked") return answered && parseComment(mine[last].body).kind === "clarify";
  if (card.status !== "backlog") return false;
  const touched = mine.some((m) => { const p = parseComment(m.body); return p.author === "agent" && (p.kind === "refine" || p.kind === "clarify"); });
  return !touched || answered;
}

/** Limits that keep a refinement minimal: the spec is a short brief, not a design doc. */
export const REFINE_LIMITS = { chars: 1500, criteria: 6 };

const byPrio = (a, b) => a.prio - b.prio || a.id.localeCompare(b.id, "en", { numeric: true });

/**
 * What the dev agent should do next, in this order:
 *   resume   the card already in progress (after a crash or restart)
 *   deploy   a Review card the PM approved in a comment: merge its PR
 *   answer   a Blocked card the PM answered in a comment: resume it on its branch
 *   feedback a Review card the PM commented on: rework it on its branch
 *   start    the top Ready card (by Prio, then ID)
 *   refine   the top Backlog card that needs its spec refined (see needsRefine); spec only, no code
 * Returns the card with `action` set, or undefined.
 */
export function nextCard(cards) {
  const doing = cards.find((c) => c.status === "in_progress");
  if (doing) return { ...doing, action: "resume" };
  for (const a of ["deploy", "answer", "feedback"]) {
    const c = cards.filter((x) => x.pending?.action === a).sort(byPrio)[0];
    if (c) return { ...c, action: a };
  }
  const ready = cards.filter((c) => c.status === "ready").sort(byPrio)[0];
  if (ready) return { ...ready, action: "start" };
  // answered clarify questions first (the PM is waiting on those), then Backlog by Prio
  const refine = cards.filter((c) => c.refine && ["blocked", "backlog"].includes(c.status))
    .sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) || byPrio(a, b))[0];
  return refine && { ...refine, action: "refine" };
}

/** Acceptance criteria as [{ n, done, text, line }] (1-based n), for `kanban -- check`. */
export function criteria(body = "") {
  const lines = body.split("\n");
  const out = [];
  let inAc = false;
  lines.forEach((l, i) => {
    if (/^## /.test(l)) inAc = /^## Acceptance criteria/i.test(l);
    const m = inAc && /^(\s*- \[)([ xX])(\]\s+)(.*)$/.exec(l);
    if (m) out.push({ n: out.length + 1, done: m[2] !== " ", text: m[4], line: i });
  });
  return out;
}

/** The body with criterion n ticked (or unticked). */
export function tickCriterion(body, n, done = true) {
  const c = criteria(body).find((x) => x.n === n);
  if (!c) throw new Error(`no acceptance criterion ${n} (there are ${criteria(body).length})`);
  const lines = body.split("\n");
  lines[c.line] = lines[c.line].replace(/^(\s*- \[)[ xX](\])/, `$1${done ? "x" : " "}$2`);
  return lines.join("\n");
}

export const sortCards = (cards) => [...cards].sort(byPrio);

/**
 * Can a card move to this status? Returns an error message, or undefined.
 * - Done only happens through a PR merged into main (never forced).
 * - Ready needs a full spec (`checkSpec`: Goal, 2+ criteria, Notes naming a file); --force overrides.
 * - WIP limit 1.
 * - Only the PM moves a card to Ready (`by: "agent"` is refused, even with force), and a Backlog card
 *   never goes straight to In progress: it has to be made Ready first.
 */
export function checkMove(card, status, cards = [], { force = false, by = "pm" } = {}) {
  if (!STATUSES.includes(status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (by === "agent" && status === "ready" && card.status !== "ready") {
    return `${card.id} can't be moved to Ready by the agent: only the PM moves a card to Ready (in the browser or from review mode).`;
  }
  if (by === "agent" && status === "in_progress" && card.status === "backlog") {
    return `${card.id} is in Backlog: the agent only refines Backlog cards. The PM has to move it to Ready before any work starts.`;
  }
  if (status === "done" && !card.merged) {
    return `${card.id} can't be Done: a card is Done only when its PR ("Closes #${card.number}") is merged into main.`;
  }
  if (force) return undefined;
  if (status === "ready" && card.status !== "ready") {
    const missing = card.specMissing ?? (card.hasCriteria ? [] : ['at least one acceptance criterion ("- [ ] …") under "## Acceptance criteria"']);
    if (missing.length) return `${card.id} can't be Ready yet: the issue body is missing\n${missing.map((m) => `  - ${m}`).join("\n")}\nUse --force to override.`;
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

/**
 * X4: the Ready gate. Returns what the issue body is missing (empty list = specified):
 * a non-empty `## Goal`, at least 2 real `- [ ]` under `## Acceptance criteria`, and a `## Notes`
 * section naming at least one file. Text under `## Original request` (the PM's quoted first draft,
 * kept by `refine`) doesn't count. Placeholders (`_…_`) don't count either.
 */
export const SPEC_MIN_CRITERIA = 2;
const FILE_REF = /[\w.-]+\/[\w./-]*[\w-]|\b[\w-]+\.(?:ts|tsx|mjs|cjs|js|json|md|html|css|ya?ml|sh)\b/;
export function checkSpec(body = "") {
  const at = body.search(/^## Original request[ \t]*$/m);
  const spec = at >= 0 ? body.slice(0, at) : body;
  const section = (name) => {
    const part = spec.split(/^## /m).slice(1).find((p) => new RegExp(`^${name}[ \t]*(\n|$)`, "i").test(p));
    return part === undefined ? undefined : part.slice(part.indexOf("\n") + 1 || part.length);
  };
  const real = (s) => s.split("\n").map((l) => l.replace(/^\s*(?:[-*]\s*)?/, "").trim()).filter((l) => l && !/^_.*_?$/.test(l));
  const missing = [];
  const goal = section("Goal");
  if (goal === undefined) missing.push('a "## Goal" section');
  else if (real(goal).length === 0) missing.push('text under "## Goal"');
  const n = criteria(spec).filter((c) => !/^_/.test(c.text)).length;
  if (n < SPEC_MIN_CRITERIA) missing.push(`at least ${SPEC_MIN_CRITERIA} acceptance criteria ("- [ ] …" under "## Acceptance criteria"; it has ${n})`);
  const notes = section("Notes");
  if (notes === undefined) missing.push('a "## Notes" section');
  else if (!FILE_REF.test(notes)) missing.push('a file to touch under "## Notes" (e.g. `extension/src/…`)');
  return missing;
}

/** True when the body's "Acceptance criteria" section has at least one real (non-placeholder) checkbox. */
export function hasCriteria(text = "") {
  const sec = text.split(/^## /m).find((p) => /^Acceptance criteria/i.test(p)) ?? "";
  return sec.split("\n").some((l) => /^\s*- \[[ x]\]\s+(?!_)\S/.test(l));
}

const ORIGINAL = /^## Original request[ \t]*$/m;

/**
 * The body `kanban -- refine` writes: the agent's spec, then the PM's original body under
 * "## Original request", blockquoted so its headings and checkboxes don't count as criteria.
 * On a later pass the existing section is kept byte for byte (never nested). An empty body or the
 * untouched new-card skeleton has nothing worth keeping. Throws if the spec isn't usable.
 */
export function refinedBody(oldBody = "", spec = "") {
  const at = (t) => { const m = ORIGINAL.exec(t); return m ? m.index : -1; };
  const draft = (at(spec) >= 0 ? spec.slice(0, at(spec)) : spec).trimEnd();
  const acs = draft.match(/^## Acceptance criteria/gim) ?? [];
  if (acs.length !== 1) throw new Error(`the refined spec needs exactly one "## Acceptance criteria" section (it has ${acs.length})`);
  if (!hasCriteria(draft)) throw new Error('the refined spec needs at least one real "- [ ] …" under "## Acceptance criteria"');
  if (criteria(draft).some((c) => /^_/.test(c.text))) throw new Error("the refined spec still has a placeholder criterion (\"- [ ] _…\")");
  if (criteria(draft).length > REFINE_LIMITS.criteria) throw new Error(`keep it minimal: at most ${REFINE_LIMITS.criteria} acceptance criteria (it has ${criteria(draft).length}); if the card needs more, it's too big: say so and suggest a split`);
  if (draft.length > REFINE_LIMITS.chars) throw new Error(`keep it minimal: the spec is ${draft.length} characters, the limit is ${REFINE_LIMITS.chars}. Cut the prose, keep the criteria`);
  let original = "";
  if (at(oldBody) >= 0) original = oldBody.slice(at(oldBody)).trimEnd();
  else if (oldBody.trim() && oldBody.trim() !== newCardBody().trim()) {
    original = "## Original request\n" + oldBody.trimEnd().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  }
  return `${draft}\n${original ? `\n${original}\n` : ""}`;
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
