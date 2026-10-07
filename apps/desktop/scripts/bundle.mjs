// Builds src-tauri/resources: node binary, bundled server + ACP adapter, web app, migrations.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = new URL("../../../", import.meta.url).pathname;
const out = new URL("../src-tauri/resources/", import.meta.url).pathname;
const server = `${root}apps/server/`;

rmSync(out, { recursive: true, force: true });
execFileSync("pnpm", ["--filter", "@zippy/web", "exec", "vite", "build"], { stdio: "inherit" });

const esm = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  // CJS deps inside an ESM bundle still call require()
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
// node-pty is a native addon: stays external, shipped as a real node_modules folder next to the bundle.
await build({ ...esm, entryPoints: [`${server}src/index.ts`], outfile: `${out}server.mjs`, external: ["node-pty"] });
const ptyDir = dirname(createRequire(`${server}package.json`).resolve("node-pty/package.json"));
cpSync(ptyDir, `${out}node_modules/node-pty`, { recursive: true, dereference: true });
chmodSync(`${out}node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`, 0o755);
// The SDK's per-platform claude binary (~200MB) is skipped: the app uses the user's own `claude`.
await build({
  ...esm,
  entryPoints: [createRequire(`${server}package.json`).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")],
  outfile: `${out}adapter.mjs`,
  external: ["@anthropic-ai/claude-agent-sdk-*"],
});

cpSync(`${root}apps/web/dist`, `${out}web`, { recursive: true });
cpSync(`${server}drizzle`, `${out}migrations`, { recursive: true });
// ponytail: ships the build machine's node (same arch only); universal build needs both arches + lipo.
cpSync(process.execPath, `${out}node`);
console.log(`bundled with node ${process.version} (${process.arch})`);
