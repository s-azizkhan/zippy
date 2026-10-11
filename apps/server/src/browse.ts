import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const HIDDEN = new Set([".git", "node_modules"]);
const MAX = 512 * 1024;

/** Absolute path of `rel` inside `root`. Throws on escape (incl. via symlink). */
export async function resolveIn(root: string, rel: string) {
  const base = await realpath(root);
  const target = await realpath(resolve(base, rel));
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Outside folder");
  return target;
}

/** Read-only view of `rel` inside `root`. */
export async function browse(root: string, rel: string) {
  const target = await resolveIn(root, rel);
  const s = await stat(target);
  if (s.isDirectory()) {
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((e) => !HIDDEN.has(e.name))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { type: "dir" as const, entries };
  }
  const buf = (await readFile(target)).subarray(0, MAX);
  if (buf.includes(0)) return { type: "file" as const, binary: true, size: s.size };
  return { type: "file" as const, binary: false, size: s.size, mtime: s.mtimeMs, truncated: s.size > MAX, content: buf.toString("utf8") };
}

/** Overwrite an existing file. `mtime` from the read guards against clobbering edits made on disk since. */
export async function saveFile(root: string, rel: string, content: string, mtime: number) {
  const target = await resolveIn(root, rel);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Not a file");
  if (s.mtimeMs !== mtime) throw Object.assign(new Error("File changed on disk since you opened it. Reload to see the latest."), { code: "STALE" });
  await writeFile(target, content);
  return { mtime: (await stat(target)).mtimeMs };
}

const LIMIT = 20_000;

/** Relative file paths under `root`: git's view (honours .gitignore) when a repo, else a walk. */
export async function listFiles(root: string) {
  const git = await promisify(execFile)("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(() => null);
  if (git) return git.stdout.split("\0").filter(Boolean).slice(0, LIMIT);
  const out: string[] = [];
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = resolve(e.parentPath, e.name).slice(resolve(root).length + 1);
    if (e.isFile() && !rel.split(sep).some((p) => HIDDEN.has(p))) out.push(rel);
    if (out.length >= LIMIT) break;
  }
  return out;
}
