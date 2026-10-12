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
// index.html must revalidate, or the webview keeps old chunk hashes across app updates
const noCacheHtml = (path: string, c: { header: (k: string, v: string) => void }) => {
  if (path.endsWith(".html")) c.header("Cache-Control", "no-cache");
};
const main = root
  ? new Hono()
      .route("/", app)
      .all("/api/*", (c) => c.notFound())
      .use("*", serveStatic({ root, onFound: noCacheHtml }))
      .all("/assets/*", (c) => c.notFound()) // stale chunk hash must 404, not get index.html as JS
      .get("*", serveStatic({ root, rewriteRequestPath: () => "/index.html", onFound: noCacheHtml }))
  : app;

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: main.fetch, port, hostname: "127.0.0.1" }, () => console.log(`zippy server http://127.0.0.1:${port}`));
const { startDomain } = await import("./domain.ts");
startDomain(main.fetch).catch((e) => console.error("https://zippy.localhost:", e.message)); // no-op until set up in Settings
(await import("./phone.ts")).initPhone(main.fetch);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (shutdown(), closeAllTerminals(), process.exit(0)));
