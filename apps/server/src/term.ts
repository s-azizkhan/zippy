import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { defaultAccountEnv } from "./claude-accounts.ts";

// pnpm drops the exec bit on the prebuilt spawn-helper, which makes every spawn fail with "posix_spawnp failed".
try {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  chmodSync(join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), 0o755);
} catch {}

// Zippy's own config (.env, desktop shell, pnpm) must not leak into user shells/agents, or `pnpm dev` there picks up our PORT/DATABASE_URL.
const OWN_ENV = new Set(["PORT", "WEB_PORT", "WEB_URL", "DATABASE_URL", "LINEAR_WEBHOOK_SECRET", "NGROK_URL", "INIT_CWD", "PNPM_SCRIPT_SRC_DIR"]);
export function userEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !OWN_ENV.has(k) && !/^(ZIPPY_|npm_)/.test(k)) env[k] = v;
  if (env.PATH) env.PATH = env.PATH.split(":").filter((p) => !p.includes("/node_modules/.bin")).join(":"); // pnpm prepends ours
  return { ...env, ...extra };
}

const SCROLLBACK = 200_000; // bytes replayed to a reconnecting client

export type TermInfo = {
  id: string;
  workspaceId: string;
  title: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  createdAt: string;
  cwd: string;
  command: string; // typed in after start (templates, "run in new terminal"); replayed on restart
  process: string; // foreground process name, e.g. zsh / node / claude
  lastDataAt: number; // epoch ms of the last output byte; drives busy / unread dots
  tags: string[]; // @agent handles and ticket identifiers; typed into the title or set by the opener
  ticketId: string | null; // ticket or chat this shell was opened for
  ticketKind: "ticket" | "chat" | null;
  agentId: string | null; // agent that opened it; null = human
  claude: ClaudeState | null; // live Claude Code session, reported by our hooks
};
/** ready = waiting for a prompt, working = mid-turn, waiting = blocked on a permission prompt, done = turn finished. */
export type ClaudeState = { state: "ready" | "working" | "waiting" | "done"; sessionId: string; since: number; note: string; mode: string; branch: string };
export type TermLink = { tags?: string[]; ticketId?: string | null; ticketKind?: "ticket" | "chat" | null; agentId?: string | null };
type Session = Omit<TermInfo, "process"> & { proc: pty.IPty; buf: string; events: EventEmitter; delaySec: number; timer?: NodeJS.Timeout; autoTitle: boolean };

/** `@handle` and `ABC-12` tokens in a title become tags, so a rename is how humans tag a shell. */
export const parseTags = (title: string) => [...new Set(title.match(/(?<!\S)(@[a-z0-9_-]+|[A-Z][A-Z0-9]{1,9}-\d+)(?!\S)/g) ?? [])];

const sessions = new Map<string, Session>();
let seq = 0;

/** Native Claude Code runs from ~/.local/share/claude/versions/<semver>, so the OS reports its name as e.g. "2.1.296". */
export const procName = (path: string) => {
  const name = path.split("/").pop()!;
  return /^\d+\.\d+\.\d+$/.test(name) ? "claude" : name;
};

const info = (s: Session): TermInfo => {
  const { proc, buf: _b, events: _e, delaySec: _d, timer: _t, autoTitle: _a, ...rest } = s;
  let p = "";
  try {
    p = s.alive ? procName(proc.process) : "";
  } catch {}
  return { ...rest, process: p };
};
export const allTerminals = (): TermInfo[] => [...sessions.values()].map(info);
export const listTerminals = (workspaceIds: string[]): TermInfo[] => [...sessions.values()].filter((s) => workspaceIds.includes(s.workspaceId)).map(info);

// Claude Code hooks → POST $ZIPPY_HOOK (this shell's /api/terminals/:id/hook). Passed with --settings on `claude` commands we type, so the user's own settings stay untouched.
// The URL lives in the shell's env, not the file: desktop, desktop-dev and web dev servers share ~/.zippy on different ports.
// ponytail: only Zippy-launched `claude` reports state; a `claude` typed by hand runs without our hooks.
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "PostToolUse", "Stop", "SessionEnd"];
let hooksPath = "";
function hooksFile() {
  if (hooksPath) return hooksPath;
  // Silent and always exit 0: hook stdout would land in Claude's context, a failure would block the turn.
  const command = `[ -n "$ZIPPY_HOOK" ] && curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "$ZIPPY_HOOK"; exit 0`;
  const hook = [{ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }];
  const dir = join(homedir(), ".zippy");
  mkdirSync(dir, { recursive: true });
  // Write-then-rename: another server rewriting it must never leave a half-written file for a starting `claude` to read.
  const tmp = join(dir, `claude-hooks.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, hook])) }, null, 2));
  renameSync(tmp, join(dir, "claude-hooks.json"));
  return (hooksPath = join(dir, "claude-hooks.json"));
}
const q = (p: string) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
/** `claude …` → `claude --settings <hooks> …`; anything else unchanged. */
export const withHooks = (command: string) => command.replace(/^claude(?=\s|$)/, () => `claude --settings ${q(hooksFile())}`);

/** (Re)starts the shell behind a session; the id stays put so open panes and links survive a restart. */
function start(s: Session, cols: number, rows: number) {
  const shell = process.env.SHELL || "/bin/zsh";
  const proc = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd: s.cwd, env: userEnv({ ...defaultAccountEnv(), TERM: "xterm-256color", ZIPPY_HOOK: `http://127.0.0.1:${process.env.PORT ?? 3001}/api/terminals/${s.id}/hook` }) });
  Object.assign(s, { proc, pid: proc.pid, alive: true, exitCode: null, buf: "", lastDataAt: Date.now(), claude: null });
  proc.onData((d) => {
    if (s.proc !== proc) return;
    s.buf = (s.buf + d).slice(-SCROLLBACK);
    s.lastDataAt = Date.now();
    s.events.emit("data", d);
  });
  proc.onExit(({ exitCode }) => {
    if (s.proc !== proc) return; // an old shell dying after restart must not mark the new one dead
    s.alive = false;
    s.exitCode = exitCode;
    s.claude = null;
    s.events.emit("exit", exitCode);
  });
  // Shell opens now; the command waits delaySec so an earlier template step (a server, a db) can be up first.
  clearTimeout(s.timer);
  if (s.command) s.timer = setTimeout(() => s.proc === proc && s.alive && proc.write(withHooks(s.command) + "\r"), s.delaySec * 1000).unref();
}

export function spawnTerminal(workspaceId: string, cwd: string, cols = 80, rows = 24, title?: string, command = "", delaySec = 0, link: TermLink = {}): TermInfo {
  const shell = (process.env.SHELL || "/bin/zsh").split("/").pop();
  const t = title || `${shell} ${++seq}`;
  const s = {
    id: randomUUID(), workspaceId, title: t, cwd, command, delaySec, createdAt: new Date().toISOString(), events: new EventEmitter().setMaxListeners(0),
    tags: [...new Set([...(link.tags ?? []), ...parseTags(t)])], ticketId: link.ticketId ?? null, ticketKind: link.ticketKind ?? null, agentId: link.agentId ?? null, autoTitle: !title,
  } as Session;
  start(s, cols, rows);
  sessions.set(s.id, s);
  return info(s);
}

export function restartTerminal(id: string) {
  const s = sessions.get(id);
  if (!s) return null;
  const { cols, rows } = s.proc;
  if (s.alive) s.proc.kill();
  s.delaySec = 0;
  start(s, cols, rows);
  s.events.emit("restart");
  return info(s);
}

export const getTerminal = (id: string) => sessions.get(id);
export const renameTerminal = (id: string, title: string) => {
  const s = sessions.get(id);
  if (s) (s.title = title), (s.tags = [...new Set([...s.tags, ...parseTags(title)])]), (s.autoTitle = false);
  return !!s;
};

export type HookInput = { hook_event_name: string; session_id?: string; prompt?: string; message?: string; notification_type?: string; permission_mode?: string };
/** Applies one Claude Code hook event. Returns the state before and after, or null for an unknown terminal. */
export function claudeHook(id: string, h: HookInput) {
  const s = sessions.get(id);
  if (!s) return null;
  const prev = s.claude?.state ?? null;
  const c: ClaudeState = s.claude ?? { state: "ready", sessionId: "", since: Date.now(), note: "", mode: "", branch: "" };
  const set = (state: ClaudeState["state"], note = "") => {
    if (c.state !== state) c.since = Date.now();
    Object.assign(c, { state, note });
  };
  if (h.session_id) c.sessionId = h.session_id;
  if (h.permission_mode) c.mode = h.permission_mode;
  switch (h.hook_event_name) {
    case "SessionStart": set("ready"); break;
    case "UserPromptSubmit": {
      set("working");
      // First real prompt names an untitled shell, like Desktop's conversation titles.
      const line = h.prompt?.trim().split("\n")[0]?.trim() ?? "";
      if (s.autoTitle && line && !line.startsWith("/")) (s.title = line.length > 48 ? `${line.slice(0, 47)}…` : line), (s.autoTitle = false);
      break;
    }
    // idle_prompt fires a minute after a finished turn; only a permission prompt means "blocked on you".
    case "Notification": if (h.notification_type ? h.notification_type === "permission_prompt" : /permission/i.test(h.message ?? "")) set("waiting", h.message ?? ""); break;
    case "PostToolUse": if (c.state === "waiting") set("working"); break;
    case "Stop": set("done"); break;
    case "SessionEnd": s.claude = null; return { s, prev, next: null };
  }
  s.claude = c;
  return { s, prev, next: c.state };
}
/** Someone has this shell's output stream open, i.e. it's on screen in a browser. */
export const watched = (id: string) => (sessions.get(id)?.events.listenerCount("data") ?? 0) > 0;
export const setTags = (id: string, tags: string[]) => {
  const s = sessions.get(id);
  if (s) s.tags = [...new Set(tags)];
  return !!s;
};
/** Last `lines` of plain-text output: ANSI and cursor sequences stripped, so an agent can read what a shell printed. */
export function readTerminal(id: string, lines = 100) {
  const s = sessions.get(id);
  if (!s) return null;
  // eslint-disable-next-line no-control-regex
  const plain = s.buf.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\r/g, "");
  return plain.split("\n").slice(-lines).join("\n");
}
export const writeTerminal = (id: string, data: string) => sessions.get(id)?.alive && sessions.get(id)!.proc.write(data);
export const resizeTerminal = (id: string, cols: number, rows: number) => {
  const s = sessions.get(id);
  if (s?.alive && cols > 0 && rows > 0) s.proc.resize(cols, rows);
};
export function closeTerminal(id: string) {
  const s = sessions.get(id);
  if (!s) return false;
  clearTimeout(s.timer);
  if (s.alive) s.proc.kill();
  sessions.delete(id);
  return true;
}
export const closeAllTerminals = () => [...sessions.keys()].forEach(closeTerminal);

export type ClaudeSession = { id: string; title: string; updatedAt: number };
// Transcripts can be hundreds of MB; titles sit near the top (first prompt) and get re-appended (ai-title), so head + tail is enough.
const PEEK = 128 * 1024;
async function peek(path: string, size: number) {
  const f = await open(path);
  try {
    const read = async (pos: number, len: number) => (len > 0 ? (await f.read(Buffer.alloc(len), 0, len, pos)).buffer.toString("utf8") : "");
    const tailAt = Math.max(PEEK, size - PEEK);
    return [await read(0, Math.min(PEEK, size)), await read(tailAt, size - tailAt)] as const;
  } finally {
    await f.close();
  }
}
/** Title of one transcript: latest custom/AI title, else the first real prompt (slash-command args count). "" = nothing worth listing. */
export function transcriptTitle(head: string, tail: string) {
  let custom = "";
  let ai = "";
  let prompt = "";
  for (const line of `${head}\n${tail}`.split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: { type?: string; aiTitle?: string; customTitle?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // cut off at a chunk edge
    }
    if (o.type === "custom-title" && o.customTitle) custom = o.customTitle;
    else if (o.type === "ai-title" && o.aiTitle) ai = o.aiTitle;
    else if (o.type === "user" && !prompt && !o.isMeta) {
      const c = o.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((x) => x?.type === "text")?.text ?? "") : "";
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
      const plain = (args ?? (text.startsWith("<") ? "" : text)).trim().split("\n")[0]!.trim();
      if (plain && !plain.startsWith("Caveat:")) prompt = plain;
    }
  }
  return (custom || ai || prompt).slice(0, 120);
}
/** Recent Claude Code conversations started in `cwd`, newest first; resumable with `claude --resume <id>`. */
export async function claudeSessions(cwd: string, limit = 12): Promise<ClaudeSession[]> {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(names.filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)).map(async (n) => ({ n, st: await stat(join(dir, n)).catch(() => null) })));
  const recent = files.filter((f) => f.st && f.st.size > 0).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs).slice(0, limit * 2);
  const out = await Promise.all(
    recent.map(async ({ n, st }) => {
      const [head, tail] = await peek(join(dir, n), st!.size).catch(() => ["", ""]);
      return { id: n.slice(0, 36), title: transcriptTitle(head, tail), updatedAt: st!.mtimeMs };
    }),
  );
  return out.filter((s) => s.title).slice(0, limit);
}
