import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";

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
};
export type TermLink = { tags?: string[]; ticketId?: string | null; ticketKind?: "ticket" | "chat" | null; agentId?: string | null };
type Session = Omit<TermInfo, "process"> & { proc: pty.IPty; buf: string; events: EventEmitter; delaySec: number; timer?: NodeJS.Timeout };

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
  const { proc, buf: _b, events: _e, delaySec: _d, timer: _t, ...rest } = s;
  let p = "";
  try {
    p = s.alive ? procName(proc.process) : "";
  } catch {}
  return { ...rest, process: p };
};
export const allTerminals = (): TermInfo[] => [...sessions.values()].map(info);
export const listTerminals = (workspaceIds: string[]): TermInfo[] => [...sessions.values()].filter((s) => workspaceIds.includes(s.workspaceId)).map(info);

/** (Re)starts the shell behind a session; the id stays put so open panes and links survive a restart. */
function start(s: Session, cols: number, rows: number) {
  const shell = process.env.SHELL || "/bin/zsh";
  const proc = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd: s.cwd, env: userEnv({ TERM: "xterm-256color" }) });
  Object.assign(s, { proc, pid: proc.pid, alive: true, exitCode: null, buf: "", lastDataAt: Date.now() });
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
    s.events.emit("exit", exitCode);
  });
  // Shell opens now; the command waits delaySec so an earlier template step (a server, a db) can be up first.
  clearTimeout(s.timer);
  if (s.command) s.timer = setTimeout(() => s.proc === proc && s.alive && proc.write(s.command + "\r"), s.delaySec * 1000).unref();
}

export function spawnTerminal(workspaceId: string, cwd: string, cols = 80, rows = 24, title?: string, command = "", delaySec = 0, link: TermLink = {}): TermInfo {
  const shell = (process.env.SHELL || "/bin/zsh").split("/").pop();
  const t = title || `${shell} ${++seq}`;
  const s = {
    id: randomUUID(), workspaceId, title: t, cwd, command, delaySec, createdAt: new Date().toISOString(), events: new EventEmitter().setMaxListeners(0),
    tags: [...new Set([...(link.tags ?? []), ...parseTags(t)])], ticketId: link.ticketId ?? null, ticketKind: link.ticketKind ?? null, agentId: link.agentId ?? null,
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
  if (s) (s.title = title), (s.tags = [...new Set([...s.tags, ...parseTags(title)])]);
  return !!s;
};
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
