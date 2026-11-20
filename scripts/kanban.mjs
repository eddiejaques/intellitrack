// Board CLI over the GitHub Project (https://github.com/users/eddiejaques/projects/1).
// Needs `gh` logged in with the `project` scope (`gh auth refresh -s project`).
//
//   npm run kanban                          summary: counts per column, Blocked and Review cards, the Ready queue
//   npm run kanban -- next                  the card the dev agent should work on (ID<TAB>title<TAB>#issue), or nothing
//   npm run kanban -- show B2               the card: fields, body and every comment, oldest first
//   npm run kanban -- set B2 ready          move a card (backlog|ready|in_progress|blocked|review|done)
//   npm run kanban -- set B2 review --branch b2-datalayer [--note "…"] [--prio n] [--force]
//   npm run kanban -- new "Title" --type bug --size S [--body-file f.md] [--ready]   new ad-hoc card X<n>
//   npm run kanban -- comment B2 "text" [--kind note|answer|feedback|blocked|change|review] [--as pm|agent] [--body-file f.md]
//   npm run kanban -- wait [--timeout 1800] [--every 60]   block until there's a card to work on
//                                           (exit 0 and print it, 3 on timeout, 4 on a stop request)
//   npm run kanban -- stop | go             ask the dev agent to stop after its card / clear that request
//   npm run kanban -- dir                   the main checkout (where the stop request file lives)
//
// Rules the CLI enforces: Ready needs acceptance criteria (--force overrides); WIP limit 1;
// Done only when the card's PR ("Closes #n") is merged into main, never by hand.
// Comments are by "agent" when run from a worktree other than the main checkout, by "pm" otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comment, createCardIssue, findCard, issueComments, listCards, project, reopenIssue, setField } from "./gh-board.mjs";
import { STATUSES, STATUS_NAMES, checkMove, formatComment, hasCriteria, newCardBody, nextCard, parseComment, sortCards } from "./kanban-lib.mjs";

function mainCheckout() {
  if (process.env.KANBAN_DIR) return process.env.KANBAN_DIR;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /^worktree (.+)$/m.exec(out)?.[1] ?? process.cwd(); // the first entry is the main checkout
  } catch { return process.cwd(); }
}

const DIR = mainCheckout();
const STOP = join(DIR, ".dev-stop");
const [cmd, ...args] = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--branch", "--note", "--prio", "--type", "--size", "--body-file", "--kind", "--as", "--timeout", "--every"]);
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const positional = () => args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function whoAmI() {
  if (flag("as")) return flag("as");
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return top === DIR ? "pm" : "agent";
  } catch { return "pm"; }
}

const line = (c) => `${c.id}\t${c.title}\t#${c.number}`;

function next() {
  const c = nextCard(listCards());
  // with a stop request, the card in progress may still be finished, but no new card is handed out
  if (existsSync(STOP) && c?.status !== "in_progress") return { stop: true };
  return { card: c };
}

try {
  if (!cmd) {
    const cards = sortCards(listCards());
    const by = (s) => cards.filter((c) => c.status === s);
    console.log(`board: ${STATUSES.map((s) => `${STATUS_NAMES[s].toLowerCase()} ${by(s).length}`).join(", ")}`);
    console.log(project().url);
    for (const s of ["in_progress", "blocked", "review", "ready"]) {
      if (!by(s).length) continue;
      console.log(`\n${STATUS_NAMES[s]}:`);
      for (const c of by(s)) {
        const pr = c.prs.find((p) => p.state === "OPEN") ?? c.prs[0];
        console.log(`  ${c.id.padEnd(5)} #${String(c.number).padEnd(4)} ${c.title.slice(0, 80)}${c.branch ? `  [${c.branch}]` : ""}${pr ? `  PR #${pr.number}${pr.merged ? " merged" : ""}` : ""}${s === "ready" && !c.hasCriteria ? "  ⚠ no acceptance criteria" : ""}`);
      }
    }
    if (existsSync(STOP)) console.log("\nstop requested: the dev agent stops after its current card (npm run kanban -- go to clear)");
  } else if (cmd === "dir") console.log(DIR);
  else if (cmd === "stop") {
    writeFileSync(STOP, new Date().toISOString() + "\n");
    const doing = listCards().find((c) => c.status === "in_progress");
    console.log(doing ? `stop requested: the dev agent finishes ${doing.id} (${doing.title}), then stops` : "stop requested: the dev agent stops before taking another card");
  } else if (cmd === "go") {
    rmSync(STOP, { force: true });
    console.log("stop request cleared");
  } else if (cmd === "next") {
    const { card, stop } = next();
    if (card) console.log(line(card));
    else if (stop) console.error("stop requested (npm run kanban -- go to clear)");
  } else if (cmd === "wait") {
    const end = Date.now() + Number(flag("timeout", 1800)) * 1000, every = Number(flag("every", 60)) * 1000;
    for (;;) {
      const { card, stop } = next();
      if (card) { console.log(line(card)); process.exit(0); }
      if (stop) die("stop requested (npm run kanban -- go to clear)", 4);
      if (Date.now() >= end) die("nothing to do yet", 3);
      await sleep(Math.min(every, Math.max(0, end - Date.now())));
    }
  } else if (cmd === "show") {
    const [id] = positional();
    if (!id) die("usage: show <ID>");
    const c = findCard(id);
    console.log(`# ${c.id}: ${c.title}`);
    console.log(`Issue #${c.number} (${c.state.toLowerCase()}) ${c.url}`);
    console.log(`Status: ${STATUS_NAMES[c.status]} · Type: ${c.type} · Size: ${c.size} · Prio: ${c.prio}${c.branch ? ` · Branch: ${c.branch}` : ""}`);
    for (const p of c.prs) console.log(`PR #${p.number} ${p.merged ? "merged" : p.state.toLowerCase()} ${p.url}`);
    console.log("\n" + c.body.trim());
    const comments = issueComments(c.number);
    if (comments.length) {
      console.log("\n## Comments (oldest first; the newest answer, feedback or change wins)\n");
      for (const m of comments) {
        const p = parseComment(m.body);
        console.log(`### ${m.createdAt.slice(0, 16).replace("T", " ")} · ${p.author} · ${p.kind}\n${p.body}\n`);
      }
    }
  } else if (cmd === "set") {
    const [id, status] = positional();
    if (!id || !STATUSES.includes(status)) die(`usage: set <ID> <${STATUSES.join("|")}> [--branch name] [--note text] [--prio n] [--force]`);
    const cards = listCards();
    const c = findCard(id, cards);
    const err = checkMove(c, status, cards, { force: args.includes("--force") });
    if (err) die(err);
    if (c.status !== status) setField(c.itemId, "Status", status);
    if (status !== "done" && c.state === "CLOSED") reopenIssue(c.number);
    if (flag("branch") !== undefined) setField(c.itemId, "Branch", flag("branch"));
    if (flag("prio") !== undefined) setField(c.itemId, "Prio", Number(flag("prio")));
    if (flag("note")) comment(c.number, formatComment(whoAmI(), status === "blocked" ? "blocked" : "note", flag("note")));
    console.log(`${c.id} -> ${status}`);
  } else if (cmd === "new") {
    const [title] = positional();
    if (!title) die('usage: new "Title" [--type bug|feature|ui|…] [--size S|M|L] [--body-file f.md] [--ready]');
    const body = flag("body-file") ? readFileSync(flag("body-file"), "utf8") : newCardBody();
    const cards = listCards();
    const n = Math.max(0, ...cards.map((c) => Number(/^X(\d+)$/.exec(c.id)?.[1] ?? 0))) + 1;
    const id = `X${n}`;
    const ready = args.includes("--ready");
    const status = ready && checkMove({ id, status: "backlog", hasCriteria: hasCriteria(body) }, "ready") === undefined ? "ready" : "backlog";
    const size = flag("size", "S");
    if (!["S", "M", "L"].includes(size)) die("size must be S, M or L");
    const r = createCardIssue({ title: `${id}: ${title}`, body, labels: [`type:${flag("type", "feature")}`], status, prio: Number(flag("prio", 0)), size });
    console.log(`${id}\t#${r.number}\t${r.url}\t${STATUS_NAMES[status]}`);
    if (ready && status !== "ready") console.error(`${id} stays in Backlog: add acceptance criteria ("- [ ] …") first`);
  } else if (cmd === "comment") {
    const [id, text] = positional();
    const body = flag("body-file") ? readFileSync(flag("body-file"), "utf8") : text;
    if (!id || !body) die('usage: comment <ID> "text" [--kind note|answer|feedback|blocked|change|review] [--as pm|agent] [--body-file f.md]');
    const c = findCard(id);
    comment(c.number, formatComment(whoAmI(), flag("kind", "note"), body));
    console.log(`${c.id}: comment added on #${c.number}`);
  } else die(`unknown command ${cmd}`);
} catch (e) {
  const msg = String(e?.stderr || e?.message || e).trim();
  die(/project/i.test(msg) && /scope/i.test(msg) ? `${msg}\nRun: gh auth refresh -s project` : msg, 1);
}

