import { appendFile, mkdir } from "node:fs/promises";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

const dir = new URL("../../../logs/", import.meta.url);
const SECRET_KEY = /token|secret|key|password|authorization/i;
const MAX = 10_000;
const SECRET = /"([^"]*(token|secret|key|password|authorization)[^"]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;

// scrub secrets, single-line, truncate
const body = (s: string) => {
  s = s.replace(SECRET, '"$1":"[REDACTED]"').replace(/\s*\n\s*/g, " ");
  return s.length > MAX ? `${s.slice(0, MAX)}…[+${s.length - MAX} chars]` : s;
};

export const reqlog: MiddlewareHandler = async (c, next) => {
  const t = Date.now();
  const id = c.req.header("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  c.header("x-request-id", id);
  const url = new URL(c.req.url);
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const req = hasBody ? await c.req.raw.clone().text().catch(() => "") : "";
  await next();
  const stream = !!c.res.headers.get("content-type")?.includes("text/event-stream"); // never ends; skip body
  const res = stream ? "" : await c.res.clone().text().catch(() => "");
  const status = c.res.status;
  const qs = [...url.searchParams].map(([k, v]) => `${k}=${SECRET_KEY.test(k) ? "[REDACTED]" : v}`).join("&");
  const level = status >= 500 || c.error ? "error" : status >= 400 ? "warn" : "info";
  const route = routePath(c);
  const line =
    `[${new Date(t).toISOString()}]:${level}:${id}:${c.req.method}:"${url.pathname}${qs && `?${qs}`}"("${route}"):${status}:${Date.now() - t}:${stream ? "[stream]" : body(res)}` +
    (req ? ` req=${body(req)}` : "") +
    (c.error ? ` err=${JSON.stringify(c.error.stack ?? c.error.message)}` : "");
  mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => appendFile(new URL(`log-${new Date(t).toISOString().slice(0, 10)}.txt`, dir), line + "\n", { mode: 0o600 }))
    .catch(() => { });
};
