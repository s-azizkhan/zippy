import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { DiffFile, FolderDiff, TestPayload } from "@zippy/shared";
import { db, orgs, ticketFolders, type tickets, type workspaces } from "./db/index.ts";
import { userEnv } from "./term.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd }).then((r) => r.stdout.trim());
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

type Ticket = typeof tickets.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
type Folder = typeof ticketFolders.$inferSelect;

/** Keep in-project worktrees out of the folder's own `git status` without touching its .gitignore. */
async function ignoreZippyDir(repo: string) {
  const file = join(await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude");
  const cur = await readFile(file, "utf8").catch(() => "");
  if (!cur.split("\n").some((l) => l.trim() === ".zippy/")) await mkdir(dirname(file), { recursive: true }).then(() => appendFile(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}.zippy/\n`));
}

/** One git worktree + branch per (ticket, folder), shared by every agent on the ticket. Non-git folders are used as-is. */
export async function ensureWorktree(ticket: Ticket, folder: Folder, ws: Workspace): Promise<{ cwd: string; branch: string | null; setupError?: string }> {
  if (folder.worktreePath && (await ok(git(folder.worktreePath, "rev-parse", "--git-dir")))) return { cwd: folder.worktreePath, branch: folder.branch };
  if (!existsSync(ws.path)) throw new Error(`Working folder ${ws.name} not found at ${ws.path}. Fix its path in Settings.`);
  if (!(await ok(git(ws.path, "rev-parse", "--is-inside-work-tree")))) return { cwd: ws.path, branch: null };

  const [{ key, useActiveBranch, worktreeDir }] = await db.select({ key: orgs.key, useActiveBranch: orgs.useActiveBranch, worktreeDir: orgs.worktreeDir }).from(orgs).where(eq(orgs.id, ticket.orgId));
  if (useActiveBranch) {
    const branch = await git(ws.path, "rev-parse", "--abbrev-ref", "HEAD");
    await db.update(ticketFolders).set({ worktreePath: ws.path, branch }).where(and(eq(ticketFolders.ticketId, ticket.id), eq(ticketFolders.workspaceId, ws.id)));
    return { cwd: ws.path, branch };
  }

  // Identifiers repeat across orgs (Linear keys), so scope by org key unless it already prefixes the id.
  const slug = ticket.identifier.startsWith(`${key}-`) ? ticket.identifier : `${key}-${ticket.identifier}`;
  const branch = `zippy/${slug.toLowerCase()}`;
  const dir = worktreeDir ? join(worktreeDir, basename(ws.path), slug) : join(ws.path, ".zippy", "worktrees", slug);
  if (!worktreeDir) await ignoreZippyDir(ws.path);
  const save = () =>
    db.update(ticketFolders).set({ worktreePath: dir, branch }).where(and(eq(ticketFolders.ticketId, ticket.id), eq(ticketFolders.workspaceId, ws.id)));
  if (existsSync(dir)) {
    // Valid but unrecorded (e.g. DB row reset): reuse it, never delete work.
    if (await ok(git(dir, "rev-parse", "--git-dir"))) return save().then(() => ({ cwd: dir, branch }));
    // Broken (its repo moved or was deleted): rebuild. The branch survives in the repo if it still exists.
    await rm(dir, { recursive: true, force: true });
    await ok(git(ws.path, "worktree", "prune"));
  }
  await ok(git(ws.path, "fetch", "origin", ws.baseBranch));
  if (await ok(git(ws.path, "rev-parse", "--verify", `refs/heads/${branch}`))) {
    await git(ws.path, "worktree", "add", dir, branch);
  } else {
    const remote = await ok(git(ws.path, "rev-parse", "--verify", `origin/${ws.baseBranch}`));
    await git(ws.path, "worktree", "add", "-b", branch, dir, remote ? `origin/${ws.baseBranch}` : ws.baseBranch);
  }
  await save();

  if (!ws.setupCmd) return { cwd: dir, branch };
  const setupError = await exec("sh", ["-c", ws.setupCmd], { cwd: dir, env: userEnv(), timeout: 10 * 60_000 }).then(
    () => undefined,
    (e: { stderr?: string; message: string }) => (e.stderr || e.message).slice(-2000),
  );
  return { cwd: dir, branch, setupError };
}

const baseRef = async (cwd: string, ws: Workspace) =>
  (await ok(git(cwd, "rev-parse", "--verify", `origin/${ws.baseBranch}`))) ? `origin/${ws.baseBranch}` : ws.baseBranch;

/** Prefix or glob match against the folder's protected paths. */
export const isRisky = (path: string, riskPaths: string[]) =>
  riskPaths.some((p) => (/[*?[]/.test(p) ? matchesGlob(path, p) : path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)));

/** Where the branch's own commits start, from its reflog: below the trailing commits, or the last rebase target. */
async function forkPoint(cwd: string, branch: string | null, fallback: string) {
  if (!branch) return fallback;
  const log = (await git(cwd, "reflog", "show", "--format=%H\t%gs", branch).catch(() => "")).split("\n").filter(Boolean);
  const own = log.find((l) => !l.split("\t")[1]!.startsWith("commit"));
  if (!own) return fallback;
  const [sha, subject] = own.split("\t") as [string, string];
  return /onto ([0-9a-f]{7,40})$/.exec(subject)?.[1] ?? sha; // a rebase replays the branch's commits onto its new base
}

const MAX_PATCH = 200_000; // per file; huge generated files would freeze the browser

/** `git diff` output split per file (keyed by new path), each capped at MAX_PATCH. */
function splitPatch(patch: string) {
  const patches = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const path = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk)?.[1];
    if (path) patches.set(path, chunk.length > MAX_PATCH ? `${chunk.slice(0, MAX_PATCH)}\n… (truncated)` : chunk);
  }
  return patches;
}

/** Branch changes vs the merge base, committed and uncommitted. Untracked files are listed without a patch. */
export async function folderDiff(folder: Folder, ws: Workspace, showMerged = false): Promise<FolderDiff> {
  const out: FolderDiff = { workspaceId: ws.id, folder: ws.name, branch: folder.branch, base: ws.baseBranch, files: [] };
  const cwd = folder.worktreePath;
  if (!cwd) return { ...out, error: "No worktree yet. It is created when an agent first needs to change code." };
  if (!(await ok(git(cwd, "rev-parse", "--git-dir")))) return { ...out, error: "The worktree is broken: its repo moved or was deleted. It is rebuilt the next time an agent runs." };
  try {
    const base = await baseRef(cwd, ws);
    const mergeBase = await git(cwd, "merge-base", base, "HEAD");
    const [head, tip] = await Promise.all([git(cwd, "rev-parse", "HEAD"), git(cwd, "rev-parse", base)]);
    let from = mergeBase;
    if (mergeBase === head && head !== tip && !(await git(cwd, "status", "--porcelain"))) {
      out.merged = true;
      if (showMerged) from = await forkPoint(cwd, folder.branch, mergeBase);
    }
    const numstat = await git(cwd, "diff", "--numstat", from);
    const patch = (await exec("git", ["diff", "--no-color", from], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
    const patches = splitPatch(patch);
    const file = (path: string, additions: number, deletions: number): DiffFile => ({ path, additions, deletions, risky: isRisky(path, ws.riskPaths), patch: patches.get(path) ?? "" });
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [a, d, path] = line.split("\t");
      out.files.push(file(path!, Number(a) || 0, Number(d) || 0)); // "-" = binary
    }
    for (const path of (await git(cwd, "ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean)) out.files.push(file(path, 0, 0));
  } catch (e) {
    out.error = (e as Error).message.split("\n")[0];
  }
  return out;
}

/** Run the folder's test command in its worktree. */
export async function runTests(folder: Folder, ws: Workspace): Promise<TestPayload> {
  const cwd = folder.worktreePath ?? ws.path;
  const start = Date.now();
  const r = await exec("sh", ["-c", ws.testCmd], { cwd, env: userEnv(), timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 }).then(
    (r) => ({ ok: true, output: r.stdout + r.stderr }),
    (e: { stdout?: string; stderr?: string; message: string }) => ({ ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") || e.message }),
  );
  return { folder: ws.name, command: ws.testCmd, ok: r.ok, output: r.output.slice(-8000), durationMs: Date.now() - start };
}

/** Commits on the folder's branch that are not on its base. 0 = nothing to PR. */
export async function commitsAhead(folder: Folder, ws: Workspace) {
  if (!folder.worktreePath) return 0;
  const cwd = folder.worktreePath;
  const base = await baseRef(cwd, ws);
  return Number(await git(cwd, "rev-list", "--count", `${base}..HEAD`).catch(() => "0"));
}

/** Push the folder's branch and open (or reuse) its PR. Agents commit; this never stages files. */
export async function openPr(ticket: Ticket, folder: Folder, ws: Workspace, title: string, body: string): Promise<string> {
  const cwd = folder.worktreePath;
  if (!cwd || !folder.branch) throw new Error(`${ws.name} has no git worktree.`);
  if (await git(cwd, "status", "--porcelain")) throw new Error(`Uncommitted changes in ${ws.name}. Commit first, then call open_pr again.`);

  await git(cwd, "push", "-u", "origin", folder.branch);
  const existing = await exec("gh", ["pr", "view", folder.branch, "--json", "url", "-q", ".url"], { cwd }).then((r) => r.stdout.trim(), () => "");
  if (existing) return existing;
  const { stdout } = await exec(
    "gh",
    ["pr", "create", "--base", ws.baseBranch, "--head", folder.branch, "--title", `[${ticket.identifier}] ${title}`, "--body", body],
    { cwd },
  );
  return stdout.trim().split("\n").at(-1)!;
}

export async function prState(cwd: string, url: string): Promise<string | null> {
  return exec("gh", ["pr", "view", url, "--json", "state", "-q", ".state"], { cwd }).then((r) => r.stdout.trim(), () => null);
}

export const mergePr = (cwd: string, url: string) => exec("gh", ["pr", "merge", url, "--squash"], { cwd });

const LOCKS: [string, string][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];

/** Folder defaults: remote default branch, install and test commands. ponytail: JS repos only. */
export async function detectFolder(path: string) {
  const head = await git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "");
  const pm = LOCKS.find(([f]) => existsSync(join(path, f)))?.[1];
  const pkg = await readFile(join(path, "package.json"), "utf8").then((t) => JSON.parse(t) as { scripts?: Record<string, string> }, () => null);
  return { baseBranch: head.replace(/^origin\//, ""), setupCmd: pm ? `${pm} install` : "", testCmd: pm && pkg?.scripts?.test ? `${pm} test` : "" };
}

// Fetch/push can hit the network: never wait on a credential prompt, never hang forever.
const remoteGit = (cwd: string, ...args: string[]) =>
  exec("git", args, { cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => (r.stdout + r.stderr).trim());

export const isRepo = (path: string) => ok(git(path, "rev-parse", "--is-inside-work-tree"));

export type Change = { path: string; status: string; orig?: string };

/** Working-tree changes from `git status -z`: M/A/D/R/U, "?" = untracked. Untracked dirs are expanded to files. */
async function status(path: string): Promise<Change[]> {
  const parts = (await exec("git", ["status", "--porcelain=v1", "-z", "-uall"], { cwd: path, maxBuffer: 16 * 1024 * 1024 })).stdout.split("\0"); // untrimmed: " M" starts with a space
  const out: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const [x, y] = [e[0]!, e[1]!];
    const c: Change = { path: e.slice(3), status: x === "?" ? "?" : y !== " " ? y : x };
    if (x === "R" || x === "C") c.orig = parts[++i]; // -z puts a rename's source in the next field
    out.push(c);
  }
  return out;
}

/** Effective commit identity and whether it comes from this repo's own config (vs global/system). */
async function identity(path: string) {
  const get = (key: string) => git(path, "config", "--show-scope", "--get", key).then((o) => o.split("\t") as [string, string], () => ["", ""] as const);
  const [[ns, name], [es, email]] = await Promise.all([get("user.name"), get("user.email")]);
  return { name, email, local: ns === "local" || es === "local" };
}

/** Set this repo's own user.name / user.email. Empty clears the override, falling back to global. */
export async function setIdentity(path: string, name: string, email: string) {
  for (const [key, v] of [["user.name", name], ["user.email", email]] as const) {
    if (v) await git(path, "config", "--local", key, v);
    else await git(path, "config", "--local", "--unset", key).catch(() => {}); // exit 5 = was not set
  }
}

/** Current branch, every local + remote branch (newest first), upstream drift, changes and stashes. null = not a git repo. */
export async function branchInfo(path: string) {
  if (!(await isRepo(path))) return null;
  const [current, refs, drift, changes, stashes, author] = await Promise.all([
    git(path, "branch", "--show-current"),
    git(path, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"),
    git(path, "rev-list", "--left-right", "--count", "@{u}...HEAD").catch(() => ""),
    status(path),
    git(path, "stash", "list").then((o) => o.split("\n").filter(Boolean).length, () => 0),
    identity(path),
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const r of refs.split("\n")) {
    if (r.startsWith("refs/heads/")) local.push(r.slice(11));
    else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) remote.push(r.slice(13));
  }
  const [behind, ahead] = drift ? drift.split("\t").map(Number) : [0, 0];
  // A remote branch with a local twin is the same choice twice.
  return { current, local, remote: remote.filter((r) => !local.includes(r.slice(r.indexOf("/") + 1))), ahead, behind, upstream: !!drift, changes, stashes, identity: author };
}

/** Switch the folder to a branch; a remote one gets a local tracking branch. Only names git listed are accepted. `stash` shelves local changes first. */
export async function checkout(path: string, branch: string, stash = false) {
  const info = await branchInfo(path);
  if (!info) throw new Error("Not a git repository.");
  const args = info.local.includes(branch) ? [branch] : info.remote.includes(branch) ? ["--track", branch] : null;
  if (!args) throw new Error(`Unknown branch: ${branch}`);
  if (stash) await git(path, "stash", "push", "-u", "-m", `zippy: before switching to ${branch}`);
  return git(path, "switch", ...args);
}

/** New branch from HEAD, switched to. Local changes come along. */
export async function createBranch(path: string, name: string) {
  if (name.startsWith("-") || !(await ok(git(path, "check-ref-format", "--branch", name)))) throw new Error(`Invalid branch name: ${name}`);
  return git(path, "switch", "-c", name);
}

/** Uncommitted changes vs HEAD with per-file patches. Untracked files have no patch. */
export async function workingDiff(path: string) {
  const changes = await status(path);
  const patch = (await exec("git", ["diff", "HEAD", "--no-color"], { cwd: path, maxBuffer: 64 * 1024 * 1024 }).catch(() => ({ stdout: "" }))).stdout;
  const patches = splitPatch(patch);
  return changes.map((c) => ({ ...c, patch: patches.get(c.path) ?? "" }));
}

/** Commit exactly `files` (staging them, deletions and renames included). Anything else already staged stays staged. */
export async function commitFiles(path: string, message: string, files: string[]) {
  const known = new Map((await status(path)).map((c) => [c.path, c]));
  const picked = files.map((f) => known.get(f));
  if (!picked.length || picked.some((c) => !c)) throw new Error("Pick changed files to commit.");
  await git(path, "add", "-A", "--", ...picked.map((c) => c!.path));
  return git(path, "commit", "-m", message, "--", ...picked.flatMap((c) => (c!.orig ? [c!.path, c!.orig] : [c!.path]))); // a rename's source is already gone from the index
}

export const popStash = (path: string) => git(path, "stash", "pop");
export const fetchAll = (path: string) => remoteGit(path, "fetch", "--all", "--prune");
export const pullFf = (path: string) => remoteGit(path, "pull", "--ff-only");
export const pushHead = (path: string) => remoteGit(path, "push", "-u", "origin", "HEAD");
