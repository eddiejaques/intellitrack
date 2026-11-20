// Board CLI. The board (plan.md, tasks/, kanban.state.json, kanban.md) always lives in the MAIN checkout,
// even when this runs from the dev agent's worktree, so both sessions see the same board.
//
//   npm run kanban                          regenerate kanban.md
//   npm run kanban -- next                  print the card the dev agent should work on (ID<TAB>title), or nothing
//   npm run kanban -- set B2 ready          move a card (backlog|ready|in_progress|blocked|review|done)
//   npm run kanban -- set B2 review --branch b2-datalayer --note "summary"
//   npm run kanban -- new "Title" --type bug --size S   scaffold tasks/X<n>.md (stays in backlog until set ready)
//   npm run kanban -- dir                   print the board directory
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATUSES, loadCards, newTaskTemplate, nextCard, normEntry, render } from "./kanban-lib.mjs";

function boardDir() {
  if (process.env.KANBAN_DIR) return process.env.KANBAN_DIR;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
    return /^worktree (.+)$/m.exec(out)?.[1] ?? process.cwd(); // the first entry is the main checkout
  } catch {
    return process.cwd();
  }
}

const DIR = boardDir();
const STATE = join(DIR, "kanban.state.json");
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const readTasks = () => {
  const d = join(DIR, "tasks");
  if (!existsSync(d)) return {};
  return Object.fromEntries(readdirSync(d).filter((f) => /^[A-Z]+\d+\.md$/.test(f)).map((f) => [f.slice(0, -3), readFileSync(join(d, f), "utf8")]));
};
const load = () => loadCards(readFileSync(join(DIR, "plan.md"), "utf8"), readState(), readTasks());

function regenerate() {
  const cards = load();
  writeFileSync(join(DIR, "kanban.md"), render(cards, readTasks()));
  const n = (s) => cards.backlog.filter((b) => b.status === s).length;
  console.log(`kanban.md: ready ${n("ready")}, in progress ${n("in_progress")}, blocked ${n("blocked")}, review ${n("review")}, done ${n("done")}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) regenerate();
else if (cmd === "dir") console.log(DIR);
else if (cmd === "next") {
  const c = nextCard(load());
  if (c) console.log(`${c.id}\t${c.item}`);
} else if (cmd === "set") {
  const [id, status] = args;
  if (!id || !STATUSES.includes(status)) {
    console.error(`usage: set <ID> <${STATUSES.join("|")}> [--branch name] [--note text]`);
    process.exit(2);
  }
  const { backlog } = load();
  const card = backlog.find((b) => b.id === id);
  if (!card) {
    console.error(`unknown card ${id}: add a plan.md §9 row or tasks/${id}.md first`);
    process.exit(2);
  }
  if (status === "ready" && !card.hasCriteria && !args.includes("--force")) {
    console.error(`${id} can't be ready: tasks/${id}.md needs at least one acceptance criterion ("- [ ] …"). Use --force to override.`);
    process.exit(2);
  }
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const state = readState();
  const entry = { ...normEntry(state[id]), status };
  for (const k of ["branch", "note"]) if (flag(k) !== undefined) entry[k] = flag(k);
  if (flag("prio") !== undefined) entry.prio = Number(flag("prio"));
  state[id] = entry;
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  console.log(`${id} -> ${status}`);
  regenerate();
} else if (cmd === "new") {
  // new "Title" [--type bug] [--size S]: scaffold tasks/X<n>.md with the next free number, status backlog
  const title = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!title) {
    console.error('usage: new "Title" [--type bug|feature|ui|…] [--size S|M|L]');
    process.exit(2);
  }
  const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  const d = join(DIR, "tasks");
  mkdirSync(d, { recursive: true });
  const n = Math.max(0, ...readdirSync(d).map((f) => Number(/^X(\d+)\.md$/.exec(f)?.[1] ?? 0))) + 1;
  const id = `X${n}`;
  writeFileSync(join(d, `${id}.md`), newTaskTemplate(id, title, flag("type", "feature"), flag("size", "S")));
  console.log(`${id}\t${join(d, `${id}.md`)}`);
  regenerate();
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
