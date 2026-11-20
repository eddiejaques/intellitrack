// GitHub side of the board: one GitHub Project ("IntelliTrack board"), one issue per card.
// All calls go through the `gh` CLI, so they use whoever is logged in (`gh auth login`, with the
// `project` scope). Pure parsing lives in kanban-lib.mjs so it can be unit-tested.
import { execFileSync } from "node:child_process";
import { STATUS_NAMES, itemToCard } from "./kanban-lib.mjs";

export const CONFIG = { owner: "eddiejaques", repo: "eddiejaques/intellitrack", project: 1 };

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20 });

export function gql(query, variables = {}) {
  const out = JSON.parse(gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables })));
  if (out.errors?.length) throw new Error(out.errors.map((e) => e.message).join("; "));
  return out.data;
}

/** REST call with a JSON body. */
export const rest = (method, path, body) => JSON.parse(gh(["api", "-X", method, path, "--input", "-"], JSON.stringify(body ?? {})) || "null");

let meta;
/** Project id and field ids/options, looked up by name once per run. */
export function project() {
  if (meta) return meta;
  const d = gql(`query($o:String!,$n:Int!){ user(login:$o){ projectV2(number:$n){ id url fields(first:50){ nodes{
    ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name } } } } } } }`, { o: CONFIG.owner, n: CONFIG.project });
  const p = d.user.projectV2;
  const fields = Object.fromEntries(p.fields.nodes.filter((f) => f.name).map((f) => [f.name, f]));
  for (const name of ["Status", "Prio", "Size", "Branch"]) if (!fields[name]) throw new Error(`project field "${name}" is missing`);
  meta = { id: p.id, url: p.url, fields };
  return meta;
}

const ITEM_FIELDS = `id
  fieldValues(first: 20) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } }
  content { ... on Issue { id number title body state url labels(first: 20) { nodes { name } }
    closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state merged url headRefName } } } }`;

/** Every card on the board (issues only; draft items and PRs are ignored). */
export function listCards() {
  const cards = [];
  let after = null;
  for (;;) {
    const d = gql(`query($o:String!,$n:Int!,$a:String){ user(login:$o){ projectV2(number:$n){ items(first:100, after:$a){
      pageInfo { hasNextPage endCursor } nodes { ${ITEM_FIELDS} } } } } }`, { o: CONFIG.owner, n: CONFIG.project, a: after });
    const page = d.user.projectV2.items;
    for (const node of page.nodes) { const c = itemToCard(node); if (c) cards.push(c); }
    if (!page.pageInfo.hasNextPage) return cards;
    after = page.pageInfo.endCursor;
  }
}

export function findCard(id, cards = listCards()) {
  const c = cards.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  if (!c) throw new Error(`no card ${id} on the board (titles start with "<ID>: ")`);
  return c;
}

export function setField(itemId, name, value) {
  const p = project();
  const f = p.fields[name];
  let v;
  if (name === "Status" || f.dataType === "SINGLE_SELECT") {
    const label = name === "Status" ? STATUS_NAMES[value] ?? value : value;
    const opt = f.options.find((o) => o.name === label);
    if (!opt) throw new Error(`${name} has no option "${label}" (has: ${f.options.map((o) => o.name).join(", ")})`);
    v = { singleSelectOptionId: opt.id };
  } else if (f.dataType === "NUMBER") v = { number: Number(value) };
  else v = { text: String(value ?? "") };
  if (name === "Branch" && !value) {
    gql(`mutation($p:ID!,$i:ID!,$f:ID!){ clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){ clientMutationId } }`, { p: p.id, i: itemId, f: f.id });
    return;
  }
  gql(`mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){ clientMutationId } }`,
    { p: p.id, i: itemId, f: f.id, v });
}

/** Create an issue, add it to the project and set its fields. Returns { number, url, itemId }. */
export function createCardIssue({ title, body, labels = [], status = "backlog", prio = 0, size = "S", branch }) {
  ensureLabels(labels);
  const issue = rest("POST", `repos/${CONFIG.repo}/issues`, { title, body, labels });
  const d = gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: project().id, c: issue.node_id });
  const itemId = d.addProjectV2ItemById.item.id;
  setField(itemId, "Status", status);
  setField(itemId, "Prio", prio);
  setField(itemId, "Size", size);
  if (branch) setField(itemId, "Branch", branch);
  return { number: issue.number, url: issue.html_url, itemId };
}

const known = new Set();
export function ensureLabels(labels) {
  if (!known.size) for (const l of JSON.parse(gh(["label", "list", "-R", CONFIG.repo, "--limit", "200", "--json", "name"]))) known.add(l.name);
  for (const l of labels) {
    if (known.has(l)) continue;
    gh(["label", "create", l, "-R", CONFIG.repo, "--color", "c5def5", "--description", "Card type"]);
    known.add(l);
  }
}

export const comment = (number, body) => gh(["issue", "comment", String(number), "-R", CONFIG.repo, "--body-file", "-"], body);
export const editBody = (number, body) => gh(["issue", "edit", String(number), "-R", CONFIG.repo, "--body-file", "-"], body);
export const closeIssue = (number) => rest("PATCH", `repos/${CONFIG.repo}/issues/${number}`, { state: "closed", state_reason: "completed" });
export const reopenIssue = (number) => rest("PATCH", `repos/${CONFIG.repo}/issues/${number}`, { state: "open" });

export function issueComments(number) {
  return JSON.parse(gh(["issue", "view", String(number), "-R", CONFIG.repo, "--json", "comments"])).comments;
}
