#!/usr/bin/env node
// Quick-add an issue: zippy "title" [body]. Filed under the working folder that contains cwd.
const [title, ...rest] = process.argv.slice(2);
if (!title) {
  console.error('usage: zippy "title" [body]');
  process.exit(1);
}
// .env dev port, server default, desktop app.
const bases = process.env.ZIPPY_URL ? [process.env.ZIPPY_URL] : [3301, 3001, 3311].map((p) => `http://127.0.0.1:${p}`);
for (const base of bases) {
  const res = await fetch(`${base}/api/quick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body: rest.join(" "), cwd: process.cwd() }),
  }).catch(() => null);
  if (!res) continue;
  const t = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`zippy: ${t.error ?? res.statusText}`);
    process.exit(1);
  }
  console.log(`${t.identifier} ${t.title}`);
  process.exit(0);
}
console.error("zippy: server not running. Start it with `pnpm dev` or open the desktop app.");
process.exit(1);
