import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { DiffFile, FolderDiff, TestPayload } from "@zippy/shared";
import { db, ticketFolders, type tickets, type workspaces } from "./db/index.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd }).then((r) => r.stdout.trim());
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

type Ticket = typeof tickets.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
type Folder = typeof ticketFolders.$inferSelect;

/** One git worktree + branch per (ticket, folder), shared by every agent on the ticket. Non-git folders are used as-is. */
export async function ensureWorktree(ticket: Ticket, folder: Folder, ws: Workspace): Promise<{ cwd: string; branch: string | null; setupError?: string }> {
  if (folder.worktreePath && (await ok(git(folder.worktreePath, "rev-parse", "--git-dir")))) return { cwd: folder.worktreePath, branch: folder.branch };
  if (!existsSync(ws.path)) throw new Error(`Working folder ${ws.name} not found at ${ws.path}. Fix its path in Settings.`);
  if (!(await ok(git(ws.path, "rev-parse", "--is-inside-work-tree")))) return { cwd: ws.path, branch: null };

  const branch = `zippy/${ticket.identifier.toLowerCase()}`;
  const dir = join(homedir(), ".zippy", "worktrees", basename(ws.path), ticket.identifier);
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
  const setupError = await exec("sh", ["-c", ws.setupCmd], { cwd: dir, timeout: 10 * 60_000 }).then(
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

/** Branch changes vs the merge base, committed and uncommitted. Untracked files are listed without a patch. */
export async function folderDiff(folder: Folder, ws: Workspace, showMerged = false): Promise<FolderDiff> {
  const out: FolderDiff = { workspaceId: ws.id, folder: ws.name, branch: folder.branch, base: ws.baseBranch, files: [] };
  const cwd = folder.worktreePath;
  if (!cwd) return { ...out, error: "No worktree yet. It is created when an agent first runs." };
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
    const patches = new Map<string, string>();
    for (const chunk of patch.split(/^(?=diff --git )/m)) {
      const path = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk)?.[1];
      if (path) patches.set(path, chunk.length > MAX_PATCH ? `${chunk.slice(0, MAX_PATCH)}\n… (truncated)` : chunk);
    }
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
  const r = await exec("sh", ["-c", ws.testCmd], { cwd, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 }).then(
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
