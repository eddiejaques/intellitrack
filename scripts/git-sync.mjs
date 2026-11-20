// Bring a card's branch up to date with GitHub using only merges that add commits: never rebase,
// reset or force. Used by `npm run kanban -- sync <ID>`; takes the repo directory so tests can
// point it at a throwaway repo.
//
//   1. git fetch origin
//   2. if origin/<branch> exists: fast-forward to it, or merge it when the two have diverged
//      (commits made on GitHub: "Update branch", web edits, the PM's pushes)
//   3. merge origin/main
//
// Exit codes: 0 synced or already up to date, 5 conflict (merge aborted, tree clean),
// 6 uncommitted changes (refuses to start), 1 any other error.
import { execFileSync } from "node:child_process";

export const SYNC_OK = 0, SYNC_ERROR = 1, SYNC_CONFLICT = 5, SYNC_DIRTY = 6;

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function tryGit(dir, args) {
  try { return { ok: true, out: git(dir, args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message || e).trim() }; }
}
const refExists = (dir, ref) => tryGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
const subjects = (dir, range) => { const o = git(dir, ["log", "--format=%s", range]); return o ? o.split("\n") : []; };

/**
 * @returns {{ code: number, branch: string, fromBranch: string[], fromMain: string[], conflicts: string[], lines: string[] }}
 * `fromBranch` / `fromMain`: subjects of the commits that came in from origin/<branch> and origin/main.
 */
export function syncBranch({ dir, branch, remote = "origin", main = "main" }) {
  const r = { code: SYNC_OK, branch, fromBranch: [], fromMain: [], conflicts: [], lines: [] };
  const say = (s) => r.lines.push(s);
  const fail = (code, msg) => { r.code = code; say(msg); return r; };
  try {
    if (!branch) return fail(SYNC_ERROR, "no branch given");
    const dirty = git(dir, ["status", "--porcelain"]);
    if (dirty) return fail(SYNC_DIRTY, `uncommitted changes, not syncing:\n${dirty}`);

    const f = tryGit(dir, ["fetch", remote]);
    if (!f.ok) return fail(SYNC_ERROR, `git fetch ${remote} failed: ${f.out}`);

    const remoteRef = `${remote}/${branch}`;
    const hasLocal = refExists(dir, `refs/heads/${branch}`);
    const hasRemote = refExists(dir, `refs/remotes/${remoteRef}`);
    if (!hasLocal && !hasRemote) return fail(SYNC_ERROR, `branch ${branch} exists neither locally nor on ${remote}`);

    // be on the card's branch (a branch only on origin gets a local tracking branch)
    const current = tryGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).out;
    if (current !== branch) {
      const co = hasLocal ? tryGit(dir, ["checkout", "-q", branch]) : tryGit(dir, ["checkout", "-q", "-b", branch, "--track", remoteRef]);
      if (!co.ok) return fail(SYNC_ERROR, `could not check out ${branch}: ${co.out}`);
      if (!hasLocal) say(`checked out ${branch} from ${remoteRef}`);
    }

    // merge one ref in; on a conflict, record the files and abort so the tree is clean again
    const mergeIn = (ref, list, { ffFirst }) => {
      const incoming = subjects(dir, `HEAD..${ref}`);
      if (!incoming.length) { say(`from ${ref}: up to date`); return true; }
      list.push(...incoming);
      let how = "fast-forward";
      let m = ffFirst ? tryGit(dir, ["merge", "--ff-only", "-q", ref]) : { ok: false };
      if (!m.ok) { how = "merged"; m = tryGit(dir, ["merge", "--no-edit", "-q", ref]); }
      if (m.ok) {
        say(`from ${ref}: ${incoming.length} commit${incoming.length === 1 ? "" : "s"} (${how})`);
        for (const s of incoming) say(`  - ${s}`);
        return true;
      }
      const files = tryGit(dir, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
      const inMerge = refExists(dir, "MERGE_HEAD");
      if (inMerge) tryGit(dir, ["merge", "--abort"]);
      if (!files.length && !inMerge) { fail(SYNC_ERROR, `merging ${ref} failed: ${m.out}`); return false; }
      r.conflicts = files;
      fail(SYNC_CONFLICT, `conflict merging ${ref} into ${branch}; merge aborted, nothing changed. Conflicting files:\n${files.map((x) => `  - ${x}`).join("\n")}`);
      return false;
    };

    if (hasRemote && hasLocal && !mergeIn(remoteRef, r.fromBranch, { ffFirst: true })) return r;
    if (!hasRemote) say(`${remoteRef}: not on ${remote} yet`);
    if (!refExists(dir, `refs/remotes/${remote}/${main}`)) return fail(SYNC_ERROR, `${remote}/${main} not found`);
    if (!mergeIn(`${remote}/${main}`, r.fromMain, { ffFirst: false })) return r;
    say(r.fromBranch.length || r.fromMain.length ? `synced ${branch}` : `${branch} already up to date`);
    return r;
  } catch (e) {
    return fail(SYNC_ERROR, String(e.stderr || e.message || e).trim());
  }
}
