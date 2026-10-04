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
try { process.loadEnvFile(); } catch {} // optional .env
const WEB_PORT = process.env.WEB_PORT ?? "5199";
const NGROK_URL = process.env.NGROK_URL;
if (process.argv[2] === "ngrok" && !NGROK_URL) (log("set NGROK_URL (e.g. https://x.ngrok-free.app)"), process.exit(1));
const [name, cmd, args, urlRe] =
  process.argv[2] === "ngrok"
    ? ["ngrok", "ngrok", ["http", "--url", NGROK_URL, "--log", "stderr", WEB_PORT], new RegExp(NGROK_URL)]
    : ["cloudflared", "cloudflared", ["tunnel", "--url", `http://localhost:${WEB_PORT}`], /https:\/\/(?!api\.)[\w-]+\.trycloudflare\.com/];
const tunnel = run(cmd, args);
tunnel.on("error", (e) => (log(`cannot start ${name}: ${e.message} (brew install ${name === "ngrok" ? "ngrok/ngrok/ngrok" : name})`), stop(1)));
tunnel.on("exit", (c) => (log(`${name} exited (code ${c}) before a URL was ready`), stop(1)));

let shown = false;
createInterface({ input: tunnel.stderr }).on("line", (line) => {
  const url = !shown && urlRe.exec(line)?.[0];
  if (url) {
    shown = true;
    qr.generate(url, { small: true }, (code) => console.log(`\n${code}\n${url}\n`));
  } else if (/\b(ERR|WRN)\b|failed/.test(line)) log(`${name}: ${line}`);
  else if (!shown) log(`${name}: ${line}`);
});

for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => stop());
