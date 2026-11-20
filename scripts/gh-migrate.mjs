// One-time move of the old file board (plan.md, tasks/*.md, kanban.state.json) onto the GitHub
// Project: one issue per card, Status/Prio/Size/Branch set, the old note posted as a comment.
// Cards that were already merged (Done) are created closed.
//
//   node scripts/gh-migrate.mjs --dir ../Intellitrack            dry run: prints what it would create
//   node scripts/gh-migrate.mjs --dir ../Intellitrack --apply
//
// Safe to re-run: cards whose ID is already on the board are skipped.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closeIssue, comment, createCardIssue, listCards } from "./gh-board.mjs";
import { formatComment, legacyCards } from "./kanban-lib.mjs";

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : process.cwd();
const apply = args.includes("--apply");

const plan = readFileSync(join(dir, "plan.md"), "utf8");
const state = existsSync(join(dir, "kanban.state.json")) ? JSON.parse(readFileSync(join(dir, "kanban.state.json"), "utf8")) : {};
const tdir = join(dir, "tasks");
const tasks = existsSync(tdir) ? Object.fromEntries(readdirSync(tdir).filter((f) => /^[A-Z]+-?\d+\.md$/.test(f)).map((f) => [f.slice(0, -3), readFileSync(join(tdir, f), "utf8")])) : {};

const cards = legacyCards(plan, state, tasks);
const onBoard = new Set(listCards().map((c) => c.id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const c of cards) {
  if (onBoard.has(c.id)) { console.log(`skip   ${c.id} (already on the board)`); continue; }
  const line = `${c.id.padEnd(5)} ${c.status.padEnd(11)} prio ${String(c.prio).padEnd(5)} ${c.size} type:${c.type}${c.branch ? ` branch ${c.branch}` : ""}  ${c.title.slice(0, 70)}`;
  if (!apply) { console.log(`create ${line}`); continue; }
  const r = createCardIssue({ title: `${c.id}: ${c.title}`, body: c.body, labels: [`type:${c.type}`], status: c.status, prio: c.prio, size: c.size, branch: c.branch });
  if (c.note) comment(r.number, formatComment(c.status === "done" ? "pm" : "agent", "note", `Carried over from the old board:\n\n${c.note}`));
  if (c.status === "done") closeIssue(r.number);
  console.log(`#${r.number} ${line}`);
  await sleep(800); // stay clear of GitHub's secondary rate limit on content creation
}
if (!apply) console.log(`\n${cards.length} cards. Dry run: add --apply to create them.`);
