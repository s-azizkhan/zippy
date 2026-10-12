import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { getRequestListener } from "@hono/node-server";
import QRCode from "qrcode";
import { readConfig, writeConfig } from "./dbadmin.ts";
import { userEnv } from "./term.ts";

// Phone access: a Cloudflare tunnel to a second loopback listener that only lets through requests carrying a secret
// (from the QR link, then a cookie). The desktop's own 127.0.0.1 listener stays unguarded.
// Two modes: quick tunnel (random trycloudflare.com URL + new secret per start) or, once a hostname on the user's
// Cloudflare account is connected, the named tunnel "zippy": same URL and secret across restarts, starts at launch.
const COOKIE = "zippy_phone";
const TUNNEL = "zippy";
const QUICK_RE = /https:\/\/(?!api\.)[\w-]+\.trycloudflare\.com/;
const CF_CERT = join(homedir(), ".cloudflared", "cert.pem");
const run = promisify(execFile);

type Cfg = { phoneHost?: string; phoneToken?: string; phoneOn?: boolean };
const cfg = () => readConfig() as Cfg;

let appFetch: ((req: Request) => Response | Promise<Response>) | null = null;
let gate: Server | null = null;
let tunnel: ChildProcess | null = null;
let token = "";
let url: string | null = null;
let error: string | null = null;

const same = (t: string) => !!token && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token));

function guard(req: Request) {
  const u = new URL(req.url);
  const t = u.searchParams.get("t");
  if (t && same(t)) {
    u.searchParams.delete("t");
    const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
    return new Response(null, { status: 302, headers: { location: u.pathname + u.search, "set-cookie": cookie } });
  }
  const c = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];
  if (!c || !same(c)) return new Response("Scan the QR code in Zippy → Settings → Connectors → Phone access.", { status: 401 });
  return appFetch!(req);
}

const cloudflared = () =>
  [...(userEnv().PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"].map((d) => d && join(d, "cloudflared")).find((f) => f && existsSync(f));
const cf = (args: string[], timeout = 60_000) => run(cloudflared()!, args, { env: userEnv(), timeout });

/** index.ts calls it at boot; a connected hostname that was on comes back on. */
export function initPhone(fetch: typeof appFetch) {
  appFetch = fetch;
  if (process.env.ZIPPY_CONFIG && cfg().phoneOn && cfg().phoneHost) startPhone().catch((e) => console.error("phone access:", e.message));
}

export async function phoneStatus() {
  const link = url && `${url}/?t=${token}`;
  return { installed: !!cloudflared(), host: cfg().phoneHost ?? null, enabled: !!tunnel, url: link, qr: link && (await QRCode.toString(link, { type: "svg", margin: 1 })), error };
}

export async function startPhone() {
  if (tunnel) return;
  if (!appFetch || !process.env.ZIPPY_WEB_DIST || !process.env.ZIPPY_CONFIG) throw new Error("Phone access needs the desktop app (in dev, run `pnpm share`).");
  const bin = cloudflared();
  if (!bin) throw new Error("cloudflared not found. Install it: brew install cloudflared");
  const { phoneHost: host, phoneToken } = cfg();
  token = host && phoneToken ? phoneToken : randomBytes(24).toString("base64url"); // quick tunnel: new secret each start
  error = url = null;
  gate = createServer(getRequestListener(guard));
  await new Promise<void>((res) => gate!.listen(0, "127.0.0.1", res));
  const origin = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
  const args = host ? ["tunnel", "--no-autoupdate", "run", "--url", origin, TUNNEL] : ["tunnel", "--no-autoupdate", "--url", origin];
  const proc = spawn(bin, args, { env: userEnv(), stdio: ["ignore", "ignore", "pipe"] });
  tunnel = proc;
  await new Promise<void>((res, rej) => {
    const fail = (m: string) => (stopPhone(), (error = m), rej(new Error(m)));
    const timer = setTimeout(() => fail("cloudflared did not connect in 30s"), 30_000);
    let last = "";
    createInterface({ input: proc.stderr! }).on("line", (line) => {
      if (/\bERR\b/.test(line)) last = line.replace(/^\S+\s+ERR\s+/, "");
      const ready = host ? /Registered tunnel connection/.test(line) && `https://${host}` : QUICK_RE.exec(line)?.[0];
      if (!url && ready) (url = ready, clearTimeout(timer), res());
    });
    proc.on("error", (e) => (clearTimeout(timer), fail(e.message)));
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (tunnel === proc) fail(last || `cloudflared exited (code ${code})`);
    });
  });
  if (host) writeConfig({ phoneToken: token, phoneOn: true }); // only once it works, or every launch retries a broken setup
}

/** `persist`: user turned it off, so a named tunnel stays off after restart too. */
export function stopPhone(persist = false) {
  const t = tunnel;
  tunnel = null;
  t?.kill();
  gate?.close();
  gate?.closeAllConnections();
  gate = null;
  url = null;
  token = "";
  if (persist && process.env.ZIPPY_CONFIG && cfg().phoneHost) writeConfig({ phoneOn: false });
}

/** Log in to Cloudflare (browser) if needed, create the "zippy" tunnel once, point the hostname's DNS at it. */
export async function connectHost(host: string) {
  if (!cloudflared()) throw new Error("cloudflared not found. Install it: brew install cloudflared");
  if (!existsSync(CF_CERT)) await cf(["tunnel", "login"], 300_000); // opens the browser, waits for the user to pick a zone
  const exists = await cf(["tunnel", "info", TUNNEL]).then(() => true, () => false);
  if (!exists) await cf(["tunnel", "create", TUNNEL]);
  await cf(["tunnel", "route", "dns", "--overwrite-dns", TUNNEL, host]);
  const wasOn = !!tunnel;
  stopPhone();
  writeConfig({ phoneHost: host, phoneToken: randomBytes(24).toString("base64url") });
  if (wasOn) await startPhone();
}

/** Back to quick tunnels. The Cloudflare tunnel and DNS record stay, so reconnecting is instant. */
export function forgetHost() {
  stopPhone();
  writeConfig({ phoneHost: undefined, phoneToken: undefined, phoneOn: undefined });
}

/** New secret: every signed-in phone is logged out, the QR changes. */
export async function rotatePhone() {
  const wasOn = !!tunnel;
  stopPhone();
  writeConfig({ phoneToken: randomBytes(24).toString("base64url") });
  if (wasOn) await startPhone();
}

process.on("exit", () => stopPhone()); // don't orphan cloudflared
