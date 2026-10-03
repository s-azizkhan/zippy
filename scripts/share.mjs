import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import qr from "qrcode-terminal";

const log = (m) => console.log(`[share] ${m}`);
const run = (cmd, args, env) => spawn(cmd, args, { stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, ...env } });

// bundled build: dev server's unbundled modules crawl over a tunnel
log("building web...");
execFileSync("pnpm", ["--filter", "@zippy/web", "exec", "vite", "build"], { stdio: "inherit" });
const servers = [run("pnpm", ["--filter", "@zippy/server", "dev"]), run("pnpm", ["--filter", "@zippy/web", "preview"], { EXPOSE: "1" })];
servers.forEach((s) => s.stderr.pipe(process.stderr));
const stop = (code = 0) => (servers.forEach((s) => s.kill()), tunnel.kill(), process.exit(code));

log("starting tunnel...");
const tunnel = run("cloudflared", ["tunnel", "--url", "http://localhost:5199"]);
tunnel.on("error", (e) => (log(`cannot start cloudflared: ${e.message} (brew install cloudflared)`), stop(1)));
tunnel.on("exit", (c) => (log(`cloudflared exited (code ${c}) before a URL was ready`), stop(1)));

let shown = false;
createInterface({ input: tunnel.stderr }).on("line", (line) => {
  const url = !shown && /https:\/\/(?!api\.)[\w-]+\.trycloudflare\.com/.exec(line)?.[0];
  if (url) {
    shown = true;
    qr.generate(url, { small: true }, (code) => console.log(`\n${code}\n${url}\n`));
  } else if (/\b(ERR|WRN)\b|failed/.test(line)) log(`cloudflared: ${line}`);
  else if (!shown) log(`cloudflared: ${line}`);
});

for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => stop());
