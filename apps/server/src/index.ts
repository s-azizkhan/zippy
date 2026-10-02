process.loadEnvFile(new URL("../../../.env", import.meta.url));

const { serve } = await import("@hono/node-server");
const { app } = await import("./app.ts");
const { shutdown } = await import("./runner.ts");

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`zippy server http://127.0.0.1:${port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (shutdown(), process.exit(0)));
