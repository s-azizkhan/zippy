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

const SCROLLBACK = 200_000; // bytes replayed to a reconnecting client

export type TermInfo = { id: string; workspaceId: string; title: string; pid: number; alive: boolean; exitCode: number | null; createdAt: string };
type Session = TermInfo & { proc: pty.IPty; buf: string; events: EventEmitter };

const sessions = new Map<string, Session>();
let seq = 0;

export const listTerminals = (workspaceIds: string[]): TermInfo[] =>
  [...sessions.values()].filter((s) => workspaceIds.includes(s.workspaceId)).map(({ proc: _p, buf: _b, events: _e, ...info }) => info);

export function spawnTerminal(workspaceId: string, cwd: string, cols = 80, rows = 24): TermInfo {
  const shell = process.env.SHELL || "/bin/zsh";
  const proc = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd, env: { ...process.env, TERM: "xterm-256color" } as Record<string, string> });
  const s: Session = { id: randomUUID(), workspaceId, title: `${shell.split("/").pop()} ${++seq}`, pid: proc.pid, alive: true, exitCode: null, createdAt: new Date().toISOString(), proc, buf: "", events: new EventEmitter().setMaxListeners(0) };
  proc.onData((d) => {
    s.buf = (s.buf + d).slice(-SCROLLBACK);
    s.events.emit("data", d);
  });
  proc.onExit(({ exitCode }) => {
    s.alive = false;
    s.exitCode = exitCode;
    s.events.emit("exit", exitCode);
  });
  sessions.set(s.id, s);
  const { proc: _p, buf: _b, events: _e, ...info } = s;
  return info;
}

export const getTerminal = (id: string) => sessions.get(id);
export const renameTerminal = (id: string, title: string) => {
  const s = sessions.get(id);
  if (s) s.title = title;
  return !!s;
};
export const writeTerminal = (id: string, data: string) => sessions.get(id)?.alive && sessions.get(id)!.proc.write(data);
export const resizeTerminal = (id: string, cols: number, rows: number) => {
  const s = sessions.get(id);
  if (s?.alive && cols > 0 && rows > 0) s.proc.resize(cols, rows);
};
export function closeTerminal(id: string) {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.alive) s.proc.kill();
  sessions.delete(id);
  return true;
}
export const closeAllTerminals = () => [...sessions.keys()].forEach(closeTerminal);
