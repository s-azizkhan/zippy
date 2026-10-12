import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getRequestListener } from "@hono/node-server";

// https://zippy.localhost with no port: own CA (name-constrained to local names, so a leaked key can't sign anything real),
// trusted in the login keychain, and listeners on 443 (+ 80 redirecting). *.localhost always resolves to loopback.
// MCP stays plain http on :80: Claude Code ignores keychain CAs (needs NODE_EXTRA_CA_CERTS at launch), and loopback needs no TLS.
export const DOMAIN = "zippy.localhost";
const DIR = join(homedir(), ".zippy", "tls");
const f = (n: string) => join(DIR, n);
const OFF = f("disabled"); // marker: certs kept, not served
const KEYCHAIN = join(homedir(), "Library/Keychains/login.keychain-db");
const CA_NAME = "Zippy Local CA";
const run = promisify(execFile);
const openssl = (args: string[]) => run("openssl", args, { cwd: DIR });

/** CA (10y) once, leaf (397d, Apple's max) when missing or under 30 days left. */
async function ensureCerts() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(f("ca.pem"))) {
    const ext = [
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "keyUsage=critical,keyCertSign,cRLSign",
      "nameConstraints=critical,permitted;DNS:localhost", // DNS only: BoringSSL (Claude Code) rejects IP constraints
    ];
    await openssl(["req", "-x509", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "3650", "-subj", `/CN=${CA_NAME}/O=Zippy`, ...ext.flatMap((e) => ["-addext", e])]);
    rmSync(f("cert.pem"), { force: true });
  }
  const leaf = existsSync(f("cert.pem")) && new X509Certificate(readFileSync(f("cert.pem")));
  if (leaf && new Date(leaf.validTo).getTime() - Date.now() > 30 * 86_400_000) return;
  writeFileSync(f("leaf.ext"), [`subjectAltName=DNS:${DOMAIN},DNS:localhost`, "basicConstraints=CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth"].join("\n"));
  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "cert.key", "-out", "cert.csr", "-subj", `/CN=${DOMAIN}`]);
  await openssl(["x509", "-req", "-in", "cert.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", `0x${Date.now().toString(16)}`, "-days", "397", "-out", "cert.pem", "-extfile", "leaf.ext"]);
  for (const k of ["ca.key", "cert.key"]) chmodSync(f(k), 0o600);
}

const trusted = () => run("security", ["verify-cert", "-c", f("cert.pem"), "-p", "ssl", "-s", DOMAIN, "-q"]).then(() => true, () => false);

// Wildcard bind is what lets a non-root process take 80/443 on macOS; so drop anything not from this machine,
// and only answer our own host names (a DNS-rebound evil.com resolving to 127.0.0.1 gets nothing).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOSTS = new Set([DOMAIN, "localhost", "127.0.0.1", "[::1]"]);
const localOnly = (s: Socket) => !LOOPBACK.has(s.remoteAddress ?? "") && s.destroy();
const listen = (srv: Server, port: number) =>
  new Promise<boolean>((res) => {
    srv.on("connection", localOnly);
    srv.once("error", (e: NodeJS.ErrnoException) => (console.error(`${DOMAIN}: port ${port}: ${e.code}`), res(false))); // e.g. the other Zippy (dev/desktop) has it
    srv.listen(port, "::", () => res(true));
  });

// Laravel Herd owns 127.0.0.1:80/443 when installed (a specific bind beats our wildcard one), so its nginx serves the
// domain instead: a site file in the dir it includes, TLS with our cert, proxied to this server's port.
const HERD = join(homedir(), "Library/Application Support/Herd");
const HERD_SITE = join(HERD, "config/valet/Nginx", DOMAIN);
const herdSite = (port: string) => `# Written by Zippy (Settings → Connectors → Local domain). Removing it there deletes this file.
server {
    listen 127.0.0.1:80;
    server_name ${DOMAIN};
    location /api/mcp/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
    }
    location / {
        return 308 https://$host$request_uri;
    }
}

server {
    listen 127.0.0.1:443 ssl;
    http2 on;
    server_name ${DOMAIN};
    client_max_body_size 64M;
    ssl_certificate "${f("cert.pem")}";
    ssl_certificate_key "${f("cert.key")}";
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        # Server-sent events (terminals, live tickets): stream, and keep idle streams open.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1d;
    }
}
`;
const viaHerd = () => existsSync(HERD_SITE);
const herdRestart = () => run(join(HERD, "bin/herd"), ["restart"], { timeout: 60_000 });

let appFetch: ((req: Request) => Response | Promise<Response>) | null = null;
let servers: Server[] = [];
export const domainActive = () => servers.length > 0 || viaHerd();

/** Start 443/80 when certs exist. index.ts calls it at boot with the app's fetch; Settings calls it after setup. */
export async function startDomain(fetch?: typeof appFetch) {
  if (fetch) appFetch = fetch;
  if (servers.length || !appFetch || !existsSync(f("cert.pem")) || existsSync(OFF)) return;
  await ensureCerts(); // renews a leaf near expiry
  if (viaHerd()) return; // Herd serves it; nginx reads the renewed files on its next restart
  const app = appFetch;
  const guarded = getRequestListener((req) => (HOSTS.has(new URL(req.url).host) ? app(req) : new Response("Unknown host", { status: 421 })));
  const https = createHttps({ key: readFileSync(f("cert.key")), cert: readFileSync(f("cert.pem")) }, guarded);
  const http = createHttp((req, res) => (req.url?.startsWith("/api/mcp/") ? guarded(req, res) : res.writeHead(308, { location: `https://${DOMAIN}${req.url ?? "/"}` }).end()));
  if (await listen(https, 443)) servers.push(https);
  if (servers.length && (await listen(http, 80))) servers.push(http);
}

function stopDomain() {
  for (const s of servers) (s.close(), s.closeAllConnections()); // keep-alive and SSE streams too, or "disabled" keeps serving
  servers = [];
}

export async function domainStatus() {
  const certs = existsSync(f("cert.pem"));
  return { domain: DOMAIN, url: `https://${DOMAIN}`, certs, trusted: certs && (await trusted()), enabled: certs && !existsSync(OFF), active: domainActive(), via: viaHerd() ? ("herd" as const) : servers.length ? ("zippy" as const) : null };
}

/** Make certs, trust the CA (macOS shows one password prompt), then serve: through Herd's nginx when installed, else our own 443/80. Also re-enables. */
export async function setupDomain() {
  rmSync(OFF, { force: true });
  await ensureCerts();
  if (!(await trusted())) await run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", KEYCHAIN, f("ca.pem")], { timeout: 120_000 });
  if (existsSync(join(HERD, "config/valet/Nginx"))) {
    stopDomain();
    writeFileSync(HERD_SITE, herdSite(process.env.PORT ?? "3001")); // re-run from the other Zippy (dev/desktop) to point it there
    await herdRestart().catch((e) => {
      rmSync(HERD_SITE, { force: true }); // else domainActive() claims a domain nothing serves
      throw e;
    });
  } else await startDomain();
}

/** Stop serving but keep the trusted certs, so enabling again needs no password. Survives restarts. */
export async function disableDomain() {
  stopDomain();
  if (existsSync(DIR)) writeFileSync(OFF, "");
  if (viaHerd()) {
    rmSync(HERD_SITE);
    await herdRestart().catch(() => {});
  }
}

/** Revoke: stop, untrust and delete the CA and certs. */
export async function removeDomain() {
  await disableDomain();
  await run("security", ["remove-trusted-cert", f("ca.pem")]).catch(() => {});
  await run("security", ["delete-certificate", "-c", CA_NAME, KEYCHAIN]).catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
}
