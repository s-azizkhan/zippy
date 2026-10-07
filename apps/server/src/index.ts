try { process.loadEnvFile(new URL("../../../.env", import.meta.url)); } catch {} // real env wins; absent in the desktop app

const { serve } = await import("@hono/node-server");
const { serveStatic } = await import("@hono/node-server/serve-static");
const { Hono } = await import("hono");
const { relative } = await import("node:path");
const { app } = await import("./app.ts");
const { shutdown } = await import("./runner.ts");
const { closeAllTerminals } = await import("./term.ts");

if (process.env.ZIPPY_CONFIG) {
  const { ensureSchema } = await import("./dbadmin.ts");
  await ensureSchema().catch((e) => console.error("schema push failed:", e.message)); // keep serving so Settings can fix the DB URL
}

// Desktop shell: serve the built web app from the same origin as /api.
const dist = process.env.ZIPPY_WEB_DIST;
const root = dist && relative(process.cwd(), dist);
const main = root
  ? new Hono().route("/", app).all("/api/*", (c) => c.notFound()).use("*", serveStatic({ root })).get("*", serveStatic({ root, rewriteRequestPath: () => "/index.html" }))
  : app;

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: main.fetch, port, hostname: "127.0.0.1" }, () => console.log(`zippy server http://127.0.0.1:${port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (shutdown(), closeAllTerminals(), process.exit(0)));
