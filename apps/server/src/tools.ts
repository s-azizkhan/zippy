import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeAuthStatus, claudeBin } from "./runner.ts";
import { userEnv } from "./term.ts";

const exec = promisify(execFile);
const BIN = join(homedir(), ".zippy", "bin"); // gh installs here: no Homebrew, no sudo
const CLAUDE_HOME = join(homedir(), ".local", "share", "claude"); // where Claude's installer puts versions
const CLAUDE_LINK = join(homedir(), ".local", "bin", "claude");

// What Zippy itself installed, so Clean removes only that and never a tool the user installed.
const MANIFEST = join(homedir(), ".zippy", "installed.json");
type Installed = { claude?: boolean; gh?: boolean; ghLogin?: boolean };
const installed = (): Installed => {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    return {};
  }
};
const mark = (patch: Installed) => {
  mkdirSync(join(homedir(), ".zippy"), { recursive: true });
  const next = Object.fromEntries(Object.entries({ ...installed(), ...patch }).filter(([, v]) => v));
  writeFileSync(MANIFEST, JSON.stringify(next));
};

/**
 * The desktop app reads the login-shell PATH once at launch. Read it again so tools installed since are found;
 * bare `exec("gh")`, `which` and userEnv all follow process.env.PATH.
 */
export async function refreshPath() {
  const shell = await exec(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "\\n%s" "$PATH"'], { timeout: 5000 }).then((r) => r.stdout.split("\n").pop()!, () => "");
  const dirs = [...(process.env.PATH ?? "").split(":"), ...shell.split(":"), join(homedir(), ".local", "bin"), BIN]; // ~/.local/bin: Claude's installer
  process.env.PATH = [...new Set(dirs.filter(Boolean))].join(":");
}

const which = (cmd: string) => exec("/usr/bin/which", [cmd]).then((r) => r.stdout.trim() || null, () => null);
const firstLine = (cmd: string, args: string[]) => exec(cmd, args, { timeout: 10_000 }).then((r) => r.stdout.trim().split("\n")[0] || null, () => null);

type Tool = { path: string | null; version: string | null; signedIn: boolean | null; error?: string };
const missing: Tool = { path: null, version: null, signedIn: null };

async function claude(): Promise<Tool> {
  const path = claudeBin();
  if (!path) return missing;
  const [version, auth] = await Promise.all([firstLine(path, ["--version"]), claudeAuthStatus()]);
  return { path, version, signedIn: auth.loggedIn, error: auth.error };
}

async function git(): Promise<Tool> {
  const path = await which("git");
  // /usr/bin/git is a stub until the Command Line Tools are installed; running it pops Apple's installer.
  if (!path || (path === "/usr/bin/git" && process.platform === "darwin" && !(await firstLine("xcode-select", ["-p"])))) return missing;
  return { path, version: await firstLine(path, ["--version"]), signedIn: null };
}

async function gh(): Promise<Tool> {
  const path = await which("gh");
  if (!path) return missing;
  const [version, signedIn] = await Promise.all([firstLine(path, ["--version"]), exec(path, ["auth", "status"], { timeout: 15_000 }).then(() => true, () => false)]);
  return { path, version, signedIn };
}

// One background job per action; the web polls /system/tools for progress.
const JOBS = ["claude", "git", "gh", "gh-login", "clean"] as const;
type JobId = (typeof JOBS)[number];
type Job = { running: boolean; log: string; error: string | null; code?: string; url?: string };
const jobs: Partial<Record<JobId, Job>> = {};
export const isJob = (id: string): id is JobId => (JOBS as readonly string[]).includes(id);

export async function toolStatus() {
  await refreshPath();
  const [c, g, h] = await Promise.all([claude(), git(), gh()]);
  return { claude: c, git: g, gh: h, jobs, platform: process.platform, installedByZippy: removable() };
}

/** Runs a command into the job log; rejects with its last output line on a non-zero exit. */
function sh(j: Job, cmd: string, args: string[], onOutput?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { env: userEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const add = (d: Buffer) => ((j.log = (j.log + d).slice(-4000)), onOutput?.());
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    p.on("error", reject);
    p.on("close", (code) => (code ? reject(new Error(j.log.trim().split("\n").pop() || `${cmd} exited with ${code}`)) : resolve()));
  });
}

/** Latest gh release for this Mac, checked against the release's checksums file, into ~/.zippy/bin. */
async function installGh(j: Job) {
  if (process.platform !== "darwin") throw new Error("Install gh from https://cli.github.com, then Recheck.");
  const rel = (await (await fetch("https://api.github.com/repos/cli/cli/releases/latest")).json()) as { assets?: { name: string; browser_download_url: string }[] };
  const assets = rel.assets ?? [];
  const zip = assets.find((a) => a.name.endsWith(`_macOS_${process.arch === "arm64" ? "arm64" : "amd64"}.zip`));
  const sums = assets.find((a) => a.name.endsWith("_checksums.txt"));
  if (!zip || !sums) throw new Error("Could not find a gh release for this Mac.");
  j.log = `Downloading ${zip.name}…\n`;
  const [data, list] = await Promise.all([fetch(zip.browser_download_url).then((r) => r.arrayBuffer()), fetch(sums.browser_download_url).then((r) => r.text())]);
  const want = list.split("\n").find((l) => l.endsWith(` ${zip.name}`))?.split(" ")[0];
  if (!want || createHash("sha256").update(Buffer.from(data)).digest("hex") !== want) throw new Error("Download checksum mismatch. Try again.");
  const dir = mkdtempSync(join(tmpdir(), "zippy-gh-"));
  try {
    writeFileSync(join(dir, "gh.zip"), Buffer.from(data));
    await sh(j, "ditto", ["-x", "-k", join(dir, "gh.zip"), dir]);
    mkdirSync(BIN, { recursive: true });
    copyFileSync(join(dir, zip.name.replace(/\.zip$/, ""), "bin", "gh"), join(BIN, "gh"));
    chmodSync(join(BIN, "gh"), 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  j.log += `Installed to ${join(BIN, "gh")}\n`;
}

/** Human labels for what Clean would remove right now. */
function removable() {
  const m = installed();
  return [
    m.claude && `Claude Code (${CLAUDE_LINK}, ${CLAUDE_HOME}). Your ~/.claude settings and history stay.`,
    m.ghLogin && "GitHub CLI sign-in (gh auth logout)",
    m.gh && `GitHub CLI (${join(BIN, "gh")}) and its git credential helper`,
  ].filter(Boolean) as string[];
}

/** Undo Zippy's installs. System tools (Homebrew, Apple's Command Line Tools, a claude you installed) are never touched. */
async function clean(j: Job) {
  const m = installed();
  const ours = join(BIN, "gh");
  if (m.ghLogin) {
    await sh(j, existsSync(ours) ? ours : "gh", ["auth", "logout", "--hostname", "github.com"]).catch((e: Error) => (j.log += `${e.message}\n`)); // already signed out is fine
    mark({ ghLogin: false });
  }
  if (m.gh) {
    // setup-git wrote `helper =` (reset) plus `helper = !<our gh> auth git-credential`; drop both only where ours is set.
    const { stdout } = await exec("git", ["config", "--global", "--get-regexp", "^credential\\..*\\.helper$"]).catch(() => ({ stdout: "" }));
    const keys = new Set(stdout.split("\n").filter((l) => l.includes(`${ours} auth git-credential`)).map((l) => l.split(" ")[0]!));
    for (const k of keys) await exec("git", ["config", "--global", "--unset-all", k, `^$|${ours.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} auth git-credential`]).catch(() => {});
    rmSync(ours, { force: true });
    try {
      rmdirSync(BIN); // only when empty
    } catch {}
    mark({ gh: false });
    j.log += `Removed ${ours}\n`;
  }
  if (m.claude) {
    // The link must point into the installer's folder; anything else at that path is the user's.
    const link = existsSync(CLAUDE_LINK) && lstatSync(CLAUDE_LINK).isSymbolicLink() && readlinkSync(CLAUDE_LINK).startsWith(CLAUDE_HOME);
    if (link) rmSync(CLAUDE_LINK, { force: true });
    rmSync(CLAUDE_HOME, { recursive: true, force: true });
    mark({ claude: false });
    j.log += `Removed Claude Code\n`;
  }
}

const actions: Record<JobId, (j: Job) => Promise<void>> = {
  claude: (j) => sh(j, "/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]).then(() => mark({ claude: true })),
  // Opens Apple's installer dialog and returns; the checklist rechecks until git shows up.
  git: (j) =>
    process.platform === "darwin" ? sh(j, "xcode-select", ["--install"]) : Promise.reject(new Error("Install git with your package manager, then Recheck.")),
  gh: (j) => installGh(j).then(() => mark({ gh: true })),
  clean,
  // Device flow: gh prints a one-time code and waits until it's entered on github.com. https protocol also sets gh as git's credential helper.
  "gh-login": async (j) => {
    await sh(j, "gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], () => {
      j.code ??= /one-time code: (\S+)/.exec(j.log)?.[1];
      j.url ??= /(https:\/\/github\.com\/login\/device)/.exec(j.log)?.[1];
    });
    mark({ ghLogin: true });
    await sh(j, "gh", ["auth", "setup-git"]);
  },
};

export function startJob(id: JobId) {
  if (jobs[id]?.running) return;
  const j: Job = { running: true, log: "", error: null };
  jobs[id] = j;
  actions[id](j)
    .catch((e: Error) => (j.error = e.message))
    .finally(() => (j.running = false));
}
