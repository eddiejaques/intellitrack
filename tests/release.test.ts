// npm run release on a throwaway repo: a bare "origin" and the PM's clone on main.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { addChangelogEntry, mergedCards, nextVersion, release } from "../scripts/release.mjs";

const ID = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
Object.assign(process.env, ID);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string, origin: string, pm: string;
const write = (f: string, t: string) => writeFileSync(join(pm, f), t);
const read = (f: string) => readFileSync(join(pm, f), "utf8");
const run = (bump = "minor") => release({ dir: pm, bump, date: "2026-11-21" });

/** a card merged the way GitHub does it: a merge commit whose body is the PR title */
function mergePr(n: number, branch: string, title: string) {
  git(pm, "checkout", "-q", "-b", branch);
  write(`${branch}.txt`, branch);
  git(pm, "add", ".");
  git(pm, "commit", "-q", "-m", `${branch} work`);
  git(pm, "checkout", "-q", "main");
  git(pm, "merge", "-q", "--no-ff", branch, "-m", `Merge pull request #${n} from owner/${branch}`, "-m", title);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-"));
  origin = join(root, "origin.git");
  pm = join(root, "pm");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, pm], { stdio: "ignore" });
  git(pm, "checkout", "-q", "-b", "main");
  write("package.json", JSON.stringify({ name: "x", version: "0.1.0", private: true }, null, 2) + "\n");
  write("package-lock.json", JSON.stringify({ name: "x", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "x", version: "0.1.0" } } }, null, 2) + "\n");
  git(pm, "add", ".");
  git(pm, "commit", "-q", "-m", "init");
  git(pm, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
  mergePr(5, "b1-ads", "B1: Google Ads conversion");
  mergePr(6, "x2-consent", "X2: Consent issues flagged first");
  git(pm, "push", "-q", "origin", "main", "--follow-tags");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("release", () => {
  it("bumps, writes a dated CHANGELOG entry of merged cards, commits and tags, without pushing", () => {
    const r = run("minor");
    expect(r.code).toBe(0);
    expect(r.tag).toBe("v0.2.0");
    expect(JSON.parse(read("package.json")).version).toBe("0.2.0");
    const lock = JSON.parse(read("package-lock.json"));
    expect([lock.version, lock.packages[""].version]).toEqual(["0.2.0", "0.2.0"]);
    const cl = read("CHANGELOG.md");
    expect(cl).toContain("## 0.2.0 (2026-11-21)");
    expect(cl).toContain("- X2: Consent issues flagged first (#6)\n- B1: Google Ads conversion (#5)");
    expect(git(pm, "log", "-1", "--format=%s")).toBe("Release v0.2.0");
    expect(git(pm, "cat-file", "-t", "v0.2.0")).toBe("tag"); // annotated, so --follow-tags pushes it
    expect(git(pm, "rev-parse", "v0.2.0^{commit}")).toBe(git(pm, "rev-parse", "HEAD"));
    expect(git(origin, "tag", "-l")).toBe("v0.1.0"); // nothing pushed
    expect(r.lines.join("\n")).toContain("git push origin main --follow-tags");
  });

  it("lists only cards merged since the last tag", () => {
    expect(run("patch").code).toBe(0);
    git(pm, "push", "-q", "origin", "main", "--follow-tags");
    mergePr(7, "b3-leadgen", "B3: Lead-gen rule pack");
    git(pm, "push", "-q", "origin", "main");
    expect(run("patch").code).toBe(0);
    const entry = read("CHANGELOG.md").split("## 0.1.2 (2026-11-21)")[1].split("## 0.1.1")[0];
    expect(entry.trim()).toBe("- B3: Lead-gen rule pack (#7)");
  });

  it("keeps a hand-written unreleased entry and only dates it", () => {
    write("CHANGELOG.md", "# Changelog\n\nIntro.\n\n## 0.2.0 (unreleased)\n\n- Curated notes.\n\n## 0.1.0 (2026-11-19)\n\n- First.\n");
    git(pm, "add", "CHANGELOG.md");
    git(pm, "commit", "-q", "-m", "notes");
    git(pm, "push", "-q", "origin", "main");
    expect(run("minor").code).toBe(0);
    expect(read("CHANGELOG.md")).toBe("# Changelog\n\nIntro.\n\n## 0.2.0 (2026-11-21)\n\n- Curated notes.\n\n## 0.1.0 (2026-11-19)\n\n- First.\n");
  });

  it("refuses on a dirty tree", () => {
    write("package.json", "{}");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.lines.join(" ")).toMatch(/uncommitted/);
  });

  it("refuses off main, and when main isn't origin/main", () => {
    git(pm, "checkout", "-q", "-b", "feature");
    expect(run().lines.join(" ")).toMatch(/cut from main.*feature/);
    git(pm, "checkout", "-q", "main");
    write("local.txt", "x");
    git(pm, "add", ".");
    git(pm, "commit", "-q", "-m", "unpushed");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.lines.join(" ")).toMatch(/not up to date.*0 behind, 1 ahead/);
    expect(git(pm, "tag", "-l")).toBe("v0.1.0");
  });

  it("refuses a bad bump or an existing tag", () => {
    expect(run("huge").lines.join(" ")).toMatch(/patch, minor or major/);
    git(pm, "tag", "v0.2.0");
    expect(run("minor").lines.join(" ")).toMatch(/tag v0.2.0 already exists/);
  });
});

describe("release helpers", () => {
  it("bumps semver", () => {
    expect(["patch", "minor", "major"].map((b) => nextVersion("1.4.9", b))).toEqual(["1.4.10", "1.5.0", "2.0.0"]);
    expect(() => nextVersion("1.4", "patch")).toThrow();
  });

  it("reads card titles from merge commits and skips main syncs", () => {
    const log = [
      "Merge pull request #49 from eddiejaques/x8-branch-sync\x1fX8: Dev agent syncs the card branch\n\x1e",
      "\nMerge fix-ga4-pinup: detect GA4 that loads but never sends\x1fCo-Authored-By: Claude <noreply@anthropic.com>\n\x1e",
      "\nMerge remote-tracking branch 'origin/main' into b2-datalayer\x1f\x1e",
      "\nMerge branch 'main' into x1\x1f\x1e",
    ].join("");
    expect(mergedCards(log)).toEqual(["X8: Dev agent syncs the card branch (#49)", "detect GA4 that loads but never sends"]);
  });

  it("starts a CHANGELOG when there is none", () => {
    const t = addChangelogEntry("", "0.1.1", "2026-11-21", ["A"]);
    expect(t).toMatch(/^# Changelog\n/);
    expect(t).toContain("## 0.1.1 (2026-11-21)\n\n- A\n");
    expect(() => addChangelogEntry(t, "0.1.1", "2026-11-22", [])).toThrow(/already has a dated/);
  });

  it("the repo's CHANGELOG has the 0.1.0 entry and a hand-written 0.2.0 entry for the first release", () => {
    const cl = readFileSync("CHANGELOG.md", "utf8");
    expect(cl).toMatch(/^## 0\.1\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
    expect(cl).toMatch(/^## 0\.2\.0 \(unreleased\)$/m);
    for (const id of ["T0–T6", "B1", "B26", "B27", "B28"]) expect(cl).toContain(id);
    expect(JSON.parse(readFileSync("package.json", "utf8")).version).toBe("0.1.0"); // `npm run release -- minor` makes it 0.2.0
  });
});
