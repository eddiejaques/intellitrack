// npm run release -- patch|minor|major
// Bump the version, add a dated CHANGELOG entry listing the cards merged since the last tag,
// commit "Release vX.Y.Z" and create the annotated tag vX.Y.Z. It never pushes: it prints the push
// command, and pushing the tag starts .github/workflows/release.yml.
//
// Refuses on a dirty tree, off `main`, or when `main` isn't exactly origin/main.
// If CHANGELOG.md already has a hand-written "## X.Y.Z (unreleased)" section for the new version,
// that text is kept and only the date is filled in.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (dir, args) => { try { return git(dir, args); } catch { return undefined; } };

export function nextVersion(v, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`package.json version "${v}" is not X.Y.Z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`bump must be patch, minor or major (got "${bump ?? ""}")`);
}

/**
 * One line per card merged into main: the PR title for "Merge pull request #n" commits, the
 * description for "Merge <branch>: <description>" ones. Syncs of main into a branch are skipped.
 * `log` is `git log --first-parent --merges --format=%s%x1f%b%x1e` output.
 */
export function mergedCards(log) {
  const out = [];
  for (const rec of log.split("\x1e")) {
    const [subject = "", body = ""] = rec.replace(/^\n+/, "").split("\x1f");
    if (!subject.trim()) continue;
    const pr = /^Merge pull request #(\d+) from \S+/.exec(subject);
    if (pr) {
      const title = body.split("\n").map((l) => l.trim()).find((l) => l && !/^co-authored-by:/i.test(l));
      out.push(`${title ?? subject} (#${pr[1]})`);
      continue;
    }
    if (/^Merge (remote-tracking )?branch '(origin\/)?main'/.test(subject)) continue;
    const m = /^Merge (?:branch ')?([^':\s]+)'?(?::\s*(.+))?/.exec(subject);
    if (m) out.push(m[2] ? m[2].trim() : m[1]);
  }
  return out;
}

/** CHANGELOG.md text with the entry for `version` added (or a hand-written unreleased one dated). */
export function addChangelogEntry(text, version, date, cards) {
  const header = "# Changelog\n\nWhat changed in each IntelliTrack release. Each release is a git tag `vX.Y.Z`; pushing it publishes the release (see docs/release.md).\n";
  const doc = text?.trim() ? text : header;
  const esc = version.replace(/\./g, "\\.");
  const curated = new RegExp(`^## \\[?${esc}\\]?(?: \\(unreleased\\))?[ \\t]*$`, "m");
  if (curated.test(doc)) return doc.replace(curated, `## ${version} (${date})`);
  if (new RegExp(`^## ${esc} \\(`, "m").test(doc)) throw new Error(`CHANGELOG.md already has a dated ${version} entry`);
  const body = cards.length ? cards.map((c) => `- ${c}`).join("\n") : "- Maintenance release.";
  const entry = `## ${version} (${date})\n\n${body}\n\n`;
  const at = doc.search(/^## /m);
  return at < 0 ? `${doc.trimEnd()}\n\n${entry}` : doc.slice(0, at) + entry + doc.slice(at);
}

/** @returns {{ code: number, version?: string, tag?: string, lines: string[] }} */
export function release({ dir = process.cwd(), bump, date = new Date().toISOString().slice(0, 10), remote = "origin", main = "main" }) {
  const lines = [];
  const fail = (msg) => ({ code: 1, lines: [...lines, msg] });
  try {
    if (git(dir, ["status", "--porcelain"])) return fail("refusing: there are uncommitted changes. Commit or stash them first.");
    const branch = tryGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (branch !== main) return fail(`refusing: releases are cut from ${main}, and you are on ${branch ?? "a detached HEAD"}.`);
    if (tryGit(dir, ["fetch", "-q", remote]) === undefined) return fail(`refusing: git fetch ${remote} failed, so I can't tell whether ${main} is up to date.`);
    const local = git(dir, ["rev-parse", "HEAD"]);
    const upstream = tryGit(dir, ["rev-parse", "--verify", "-q", `${remote}/${main}`]);
    if (!upstream) return fail(`refusing: ${remote}/${main} not found.`);
    if (local !== upstream) {
      const behind = git(dir, ["rev-list", "--count", `HEAD..${remote}/${main}`]);
      const ahead = git(dir, ["rev-list", "--count", `${remote}/${main}..HEAD`]);
      return fail(`refusing: ${main} is not up to date with ${remote}/${main} (${behind} behind, ${ahead} ahead). Run git pull (and push anything local) first.`);
    }

    const pkgPath = join(dir, "package.json");
    const pkgText = readFileSync(pkgPath, "utf8");
    const current = JSON.parse(pkgText).version;
    const version = nextVersion(current, bump);
    const tag = `v${version}`;
    if (tryGit(dir, ["rev-parse", "--verify", "-q", `refs/tags/${tag}`])) return fail(`refusing: tag ${tag} already exists.`);

    const last = tryGit(dir, ["describe", "--tags", "--abbrev=0", "--match", "v*"]);
    const log = git(dir, ["log", "--first-parent", "--merges", "--format=%s%x1f%b%x1e", ...(last ? [`${last}..HEAD`] : ["HEAD"])]);
    const cards = mergedCards(log);

    writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
    const files = ["package.json"];
    const lockPath = join(dir, "package-lock.json");
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
      files.push("package-lock.json");
    }
    const clPath = join(dir, "CHANGELOG.md");
    writeFileSync(clPath, addChangelogEntry(existsSync(clPath) ? readFileSync(clPath, "utf8") : "", version, date, cards));
    files.push("CHANGELOG.md");

    git(dir, ["add", ...files]);
    git(dir, ["commit", "-q", "-m", `Release ${tag}`]);
    git(dir, ["tag", "-a", tag, "-m", `IntelliTrack ${tag}`]);
    lines.push(`${current} -> ${version}: committed "Release ${tag}" and tagged ${tag}`);
    lines.push(`CHANGELOG.md: ${cards.length} merged card(s) since ${last ?? "the start"}`);
    lines.push("", "Nothing is pushed yet. To publish, run:", `  git push ${remote} ${main} --follow-tags`, "", "That starts the release pipeline (.github/workflows/release.yml).");
    return { code: 0, version, tag, lines };
  } catch (e) {
    return fail(String(e?.stderr || e?.message || e).trim());
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = release({ bump: process.argv[2] });
  for (const l of r.lines) (r.code ? console.error : console.log)(l);
  process.exit(r.code);
}
