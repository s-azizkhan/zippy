import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

/** Applies drizzle/ migrations. A DB made by `db:push` (tables, no history) is marked as at 0000_init first. */
export async function ensureSchema() {
  const folder = process.env.ZIPPY_MIGRATIONS ?? fileURLToPath(new URL("../drizzle", import.meta.url));
  const sql = open(process.env.DATABASE_URL!);
  try {
    const [{ pushed }] = await sql`select to_regclass('public.orgs') is not null and to_regclass('drizzle.__drizzle_migrations') is null as pushed`;
    if (pushed) {
      const [init] = readMigrationFiles({ migrationsFolder: folder });
      await sql`create schema drizzle`;
      await sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
      await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${init!.hash}, ${init!.folderMillis})`;
    }
    await migrate(drizzle(sql), { migrationsFolder: folder });
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Desktop shell's config.json (ZIPPY_CONFIG). Keys: databaseUrl, hotkey. */
export function readConfig(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(process.env.ZIPPY_CONFIG!, "utf8")); } catch { return {}; }
}
export function writeConfig(patch: Record<string, unknown>) {
  const cfg = { ...readConfig(), ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete cfg[k];
  writeFileSync(process.env.ZIPPY_CONFIG!, JSON.stringify(cfg, null, 2));
}

/** Desktop shell restarts the server after a DB change. `null` = built-in DB. */
export function saveDbUrl(url: string | null) {
  writeConfig({ databaseUrl: url ?? undefined });
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
}
