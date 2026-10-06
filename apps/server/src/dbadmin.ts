import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const NO_DB = "3D000";
const open = (url: string) => postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });

export const maskUrl = (url?: string) => url?.replace(/(:\/\/[^:@/]+):[^@]*@/, "$1:***@") ?? "";

export async function testDb(url: string) {
  const sql = open(url);
  try {
    await sql`select 1`;
    return { ok: true as const };
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { ok: false as const, missing: err.code === NO_DB, error: err.message };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function createDb(url: string) {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  u.pathname = "/postgres";
  const sql = open(u.href);
  try {
    await sql.unsafe(`create database "${name.replaceAll('"', '""')}"`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** `drizzle-kit push`, no config file. No --force: a push that would drop data aborts instead of prompting. */
export const ensureSchema = () =>
  new Promise<void>((resolve, reject) =>
    execFile(
      fileURLToPath(new URL("../node_modules/.bin/drizzle-kit", import.meta.url)),
      ["push", "--dialect=postgresql", "--schema=./src/db/schema.ts", `--url=${process.env.DATABASE_URL}`],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 120_000 },
      (err, out, stderr) => (err ? reject(new Error(stderr.trim() || out.trim().split("\n").pop() || err.message)) : resolve()),
    ),
  );

/** Desktop shell owns this file and restarts the server after a change. `null` = built-in DB. */
export function saveDbUrl(url: string | null) {
  const file = process.env.ZIPPY_CONFIG!;
  const cfg: Record<string, unknown> = (() => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } })();
  if (url) cfg.databaseUrl = url;
  else delete cfg.databaseUrl;
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
}
