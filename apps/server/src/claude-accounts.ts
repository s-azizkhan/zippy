import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import * as pty from "node-pty";
import { claudeAccounts, db } from "./db/index.ts";

export type ClaudeAccount = typeof claudeAccounts.$inferSelect;
type Account = ClaudeAccount;
const AUTH_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/** Env that makes `claude` run as `a`; blanks every other credential so the machine's login or a stray key can't win. No account = machine login. */
export function accountEnv(a?: Pick<Account, "method" | "secret"> | null): Record<string, string> {
  if (!a) return {};
  return { ...Object.fromEntries(AUTH_KEYS.map((k) => [k, ""])), [a.method === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: a.secret };
}

// In-memory copy of the default account: terminals spawn synchronously. Reloaded at startup and after every change here.
let current: Account | null = null;
export const defaultAccount = () => current;
export async function refreshDefault() {
  const [a] = await db.select().from(claudeAccounts).where(eq(claudeAccounts.isDefault, true));
  current = a ?? null;
}

/** Env for anything that runs `claude` as the default account (agents, terminals). */
export const defaultAccountEnv = () => accountEnv(current);
export async function getAccount(id: string) {
  const [a] = await db.select().from(claudeAccounts).where(eq(claudeAccounts.id, id));
  return a ?? null;
}

/** Everything but the secret. */
export async function listAccounts() {
  const rows = await db.select().from(claudeAccounts).orderBy(desc(claudeAccounts.isDefault), claudeAccounts.createdAt);
  return rows.map(({ secret, ...a }) => ({ ...a, hint: `…${secret.slice(-4)}` }));
}

export async function addAccount(label: string, method: Account["method"], secret: string) {
  const [a] = await db.insert(claudeAccounts).values({ label, method, secret, isDefault: !current }).returning({ id: claudeAccounts.id });
  await refreshDefault();
  return a!.id;
}

/** `id` = null clears the default, back to the machine login. */
export async function setDefault(id: string | null) {
  await db.transaction(async (tx) => {
    await tx.update(claudeAccounts).set({ isDefault: false });
    if (id) await tx.update(claudeAccounts).set({ isDefault: true }).where(eq(claudeAccounts.id, id));
  });
  await refreshDefault();
}

export async function renameAccount(id: string, label: string) {
  await db.update(claudeAccounts).set({ label }).where(eq(claudeAccounts.id, id));
  await refreshDefault();
}

export const allAccounts = () => db.select().from(claudeAccounts).orderBy(claudeAccounts.createdAt);

export async function removeAccount(id: string) {
  await db.delete(claudeAccounts).where(eq(claudeAccounts.id, id));
  await refreshDefault();
}

// --- Sign in with Claude: drives `claude setup-token` in a pty (same flow as Paperclip's login runner). ---

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;
/** The sign-in link and the minted token out of the raw pty stream. The pty is 1000 cols wide so neither wraps. */
export function parseSetupToken(raw: string) {
  const text = raw.replace(ANSI, "");
  return {
    prompted: /paste\s*code/i.test(text), // cursor-move codes eat the spaces, so "Pastecodehere"
    url: text.match(/https:\/\/(?:claude\.ai|claude\.com)\/\S+/)?.[0] ?? null,
    token: text.match(/sk-ant-oat\d+-[A-Za-z0-9_-]+/)?.[0] ?? null,
    error: text.match(/OAuth error:\s*([^\r\n]*)/)?.[1]?.trim() || null,
  };
}

export type Login = { status: "starting" | "awaiting_code" | "saving" | "done" | "error"; url?: string; error?: string };
type Session = Login & { proc: pty.IPty; buf: string; label: string; timer: NodeJS.Timeout; submitted?: boolean };
const logins = new Map<string, Session>();
const LOGIN_TIMEOUT = 5 * 60_000;

export function startLogin(claudePath: string, label: string) {
  const id = randomUUID();
  const proc = pty.spawn(claudePath, ["setup-token"], { name: "xterm-256color", cols: 1000, rows: 30, env: { ...(process.env as Record<string, string>), ...Object.fromEntries(AUTH_KEYS.map((k) => [k, ""])) } });
  const s: Session = { status: "starting", proc, buf: "", label, timer: setTimeout(() => finish(id, "login timed out"), LOGIN_TIMEOUT) };
  logins.set(id, s);
  proc.onData((d) => {
    s.buf += d;
    if (s.status === "starting") {
      const { url, prompted } = parseSetupToken(s.buf);
      if (url && prompted) Object.assign(s, { status: "awaiting_code", url });
    }
    // A rejected code: the CLI prints "OAuth error: …" and waits for Enter. The code is single-use, so end the login.
    const bad = s.submitted && s.status === "awaiting_code" && parseSetupToken(s.buf).error;
    if (bad) finish(id, `Sign-in rejected: ${bad}. Start again.`);
  });
  proc.onExit(async ({ exitCode }) => {
    clearTimeout(s.timer);
    if (s.status === "error") return;
    const { token } = parseSetupToken(s.buf);
    if (exitCode !== 0 || !token) return Object.assign(s, { status: "error", error: "Sign-in failed or was rejected. Try again." });
    s.status = "saving";
    try {
      await addAccount(s.label, "oauth", token);
      s.status = "done";
    } catch (e) {
      Object.assign(s, { status: "error", error: (e as Error).message });
    }
    s.buf = ""; // token no longer needed in memory
    setTimeout(() => logins.delete(id), 60_000);
  });
  return id;
}

function finish(id: string, error: string) {
  const s = logins.get(id);
  if (!s) return;
  Object.assign(s, { status: "error", error });
  s.buf = "";
  try { s.proc.kill(); } catch {}
}

export const loginState = (id: string): Login | null => {
  const s = logins.get(id);
  return s ? { status: s.status, url: s.url, error: s.error } : null;
};

/** Browser code → pty. Ink treats a glued `\r` as pasted text, so Return goes in as its own write. */
export function submitLoginCode(id: string, code: string) {
  const s = logins.get(id);
  if (s?.status !== "awaiting_code") return false;
  s.submitted = true;
  s.proc.write(code.trim());
  setTimeout(() => s.proc.write("\r"), 150);
  return true;
}

export function cancelLogin(id: string) {
  finish(id, "cancelled");
  setTimeout(() => logins.delete(id), 60_000);
}

// --- Probe output ---

export type Usage = Record<"five_hour" | "seven_day", { utilization: number; resets_at: string } | null>;

/** `claude -p --output-format stream-json` lines → final result text and plan usage from the rate_limit_event (utilization 0-1 → percent). */
export function parseProbe(stdout: string) {
  let result: string | null = null;
  let isError = false;
  let usage: Usage | undefined;
  for (const line of stdout.split("\n")) {
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "result") (result = m.result ?? "", (isError = !!m.is_error));
    const w = m.type === "rate_limit_event" && m.rate_limit_info?.unifiedWindows;
    if (w) {
      const one = (k: string) => (w[k] ? { utilization: Math.round(w[k].utilization * 1000) / 10, resets_at: new Date(w[k].resetsAt * 1000).toISOString() } : null);
      usage = { five_hour: one("five_hour"), seven_day: one("seven_day") };
    }
  }
  return { result, isError, usage };
}

/** Error text that means the account is out of quota (as opposed to broken auth or a server hiccup). */
export const LIMIT_RE = /(?:usage|rate|session|weekly|5-hour)[\s_-]*limit|limit\s+reached|too\s+many\s+requests|\b429\b|exceeded.{0,30}(?:limit|quota)/i;
