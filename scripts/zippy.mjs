#!/usr/bin/env node
// Quick-add an issue: zippy "title" [body]. Filed under the working folder that contains cwd.
// Piped stdin (pytest 2>&1 | zippy "fix tests") is appended to the body as a code block.
const [title, ...rest] = process.argv.slice(2);
if (!title) {
  console.error('usage: zippy "title" [body]   (stdin is appended: cmd 2>&1 | zippy "title")');
  process.exit(1);
}
let text = rest.join(" ");
if (!process.stdin.isTTY) {
  let piped = "";
  for await (const chunk of process.stdin) piped += chunk;
  piped = piped.trim();
  // ponytail: keep the tail, that is where the failure is
  const lines = piped.split("\n");
  if (lines.length > 200) piped = `… (${lines.length - 200} lines dropped)\n` + lines.slice(-200).join("\n");
  if (piped) text = `${text}\n\n\`\`\`\n${piped}\n\`\`\``.trim();
}
// .env dev port, server default, desktop app.
const bases = process.env.ZIPPY_URL ? [process.env.ZIPPY_URL] : [3301, 3001, 3311].map((p) => `http://127.0.0.1:${p}`);
for (const base of bases) {
  const res = await fetch(`${base}/api/quick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body: text, cwd: process.cwd() }),
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
