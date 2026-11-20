// syncBranch against throwaway repos: a bare "origin", the agent's clone ("work") and a second
// clone that plays GitHub (the PM's "Update branch", web edits, merges to main).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { SYNC_CONFLICT, SYNC_DIRTY, SYNC_ERROR, SYNC_OK, syncBranch } from "../scripts/git-sync.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string, origin: string, work: string, gh: string;
const commit = (dir: string, file: string, text: string, msg: string) => { writeFileSync(join(dir, file), text); git(dir, "add", file); git(dir, "commit", "-q", "-m", msg); };
const head = (dir: string) => git(dir, "rev-parse", "HEAD");
const clean = (dir: string) => git(dir, "status", "--porcelain") === "";
const sync = (branch = "x1-card") => syncBranch({ dir: work, branch });

beforeEach(() => {
  Object.assign(process.env, { GIT_AUTHOR_NAME: ENV.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: ENV.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: ENV.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: ENV.GIT_COMMITTER_EMAIL });
  root = mkdtempSync(join(tmpdir(), "gitsync-"));
  origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
  work = join(root, "work");
  gh = join(root, "gh");
  execFileSync("git", ["clone", "-q", origin, work], { env: ENV, stdio: "ignore" });
  git(work, "checkout", "-q", "-b", "main");
  commit(work, "a.txt", "one\n", "initial");
  git(work, "push", "-q", "origin", "main");
  git(work, "checkout", "-q", "-b", "x1-card");
  commit(work, "card.txt", "card\n", "card work");
  git(work, "push", "-q", "-u", "origin", "x1-card");
  execFileSync("git", ["clone", "-q", origin, gh], { env: ENV, stdio: "ignore" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("syncBranch", () => {
  it("does nothing when already up to date", () => {
    const before = head(work);
    const r = sync();
    expect(r.code).toBe(SYNC_OK);
    expect(r.fromBranch).toEqual([]);
    expect(r.fromMain).toEqual([]);
    expect(head(work)).toBe(before);
    expect(r.lines.at(-1)).toContain("already up to date");
  });

  it("fast-forwards to commits made on GitHub", () => {
    git(gh, "checkout", "-q", "x1-card");
    commit(gh, "card.txt", "card, edited on GitHub\n", "Edit card.txt on GitHub");
    git(gh, "push", "-q");
    const r = sync();
    expect(r.code).toBe(SYNC_OK);
    expect(r.fromBranch).toEqual(["Edit card.txt on GitHub"]);
    expect(head(work)).toBe(head(gh));
    expect(r.lines.join("\n")).toContain("fast-forward");
  });

  it("merges when the local and GitHub branches have diverged, keeping both sides", () => {
    git(gh, "checkout", "-q", "x1-card");
    commit(gh, "gh.txt", "from GitHub\n", "PM fix");
    git(gh, "push", "-q");
    commit(work, "local.txt", "local\n", "agent step");
    const mine = head(work);
    const r = sync();
    expect(r.code).toBe(SYNC_OK);
    expect(r.fromBranch).toEqual(["PM fix"]);
    expect(git(work, "merge-base", "--is-ancestor", mine, "HEAD")).toBe("");
    expect(existsSync(join(work, "gh.txt")) && existsSync(join(work, "local.txt"))).toBe(true);
    expect(r.lines.join("\n")).toContain("merged");
  });

  it("merges origin/main when main moved on", () => {
    commit(gh, "a.txt", "one\ntwo\n", "Merge pull request #9");
    git(gh, "push", "-q", "origin", "main");
    const r = sync();
    expect(r.code).toBe(SYNC_OK);
    expect(r.fromMain).toEqual(["Merge pull request #9"]);
    expect(git(work, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
    expect(existsSync(join(work, "card.txt"))).toBe(true);
  });

  it("aborts a conflicting merge, leaves the tree clean and names the files", () => {
    commit(gh, "card.txt", "main's version\n", "touch card.txt on main");
    git(gh, "push", "-q", "origin", "main");
    const before = head(work);
    const r = sync();
    expect(r.code).toBe(SYNC_CONFLICT);
    expect(r.conflicts).toEqual(["card.txt"]);
    expect(head(work)).toBe(before);
    expect(clean(work)).toBe(true);
    expect(existsSync(join(work, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("refuses to start with uncommitted changes", () => {
    writeFileSync(join(work, "card.txt"), "half done\n");
    writeFileSync(join(work, "new.txt"), "untracked\n");
    const before = head(work);
    const r = sync();
    expect(r.code).toBe(SYNC_DIRTY);
    expect(head(work)).toBe(before);
    expect(r.lines[0]).toContain("uncommitted");
  });

  it("checks out a branch that exists only on origin", () => {
    git(gh, "checkout", "-q", "-b", "x2-other", "origin/main");
    commit(gh, "x2.txt", "x2\n", "x2 started elsewhere");
    git(gh, "push", "-q", "-u", "origin", "x2-other");
    const r = sync("x2-other");
    expect(r.code).toBe(SYNC_OK);
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("x2-other");
    expect(head(work)).toBe(head(gh));
  });

  it("syncs a branch that exists only locally (not pushed yet)", () => {
    git(work, "checkout", "-q", "-b", "x3-local", "origin/main");
    commit(work, "x3.txt", "x3\n", "x3 step");
    commit(gh, "a.txt", "one\nmain moved\n", "main moved");
    git(gh, "push", "-q", "origin", "main");
    const r = sync("x3-local");
    expect(r.code).toBe(SYNC_OK);
    expect(r.fromMain).toEqual(["main moved"]);
    expect(r.lines.join("\n")).toContain("not on origin yet");
  });

  it("errors on an unknown branch, and never rewrites history", () => {
    expect(sync("nope").code).toBe(SYNC_ERROR);
    expect(sync("").code).toBe(SYNC_ERROR);
    const src = execFileSync("cat", ["scripts/git-sync.mjs"], { encoding: "utf8" });
    expect(src).not.toMatch(/"(rebase|reset|--force|-f|push)"/);
  });
});
