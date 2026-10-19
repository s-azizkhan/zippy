import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Real Chromium against a local fixture: inner scroller with an infinite list, open shadow DOM, a cross-origin
// iframe (second port), a dialog, console errors, a 404 and a cookie. Skips when no Chromium-family browser is installed.
const tmp = mkdtempSync(join(tmpdir(), "zippy-browser-"));
process.env.ZIPPY_CONFIG = join(tmp, "config.json");
process.env.ZIPPY_DOWNLOADS = join(tmp, "downloads");
const b = await import("./browser.ts");

const page = (frame: string) => `<!doctype html><title>Fixture</title>
<style>html,body{height:100%;margin:0;overflow:hidden} #list{height:300px;overflow:auto}</style>
<h1>Fixture</h1><div id="list" aria-label="Messages"></div><x-card></x-card>
<a href="/report.txt" download>Get report</a>
<button id="ask" onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<iframe src="${frame}/frame" width="300" height="120"></iframe>
<script>
let n = 0, loads = 0;
const add = (k) => { for (let i = 0; i < k; i++) { const d = document.createElement('div'); d.style.height = '40px'; d.innerHTML = '<a href="#m' + n + '">Message ' + n++ + '</a>'; list.append(d); } };
add(30);
list.onscroll = () => { if (loads < 2 && list.scrollTop + list.clientHeight >= list.scrollHeight - 10) setTimeout(() => (loads++, add(20)), 200); };
customElements.define('x-card', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<p>Shadow text</p><button>Shadow button</button>'; r.querySelector('button').onclick = () => (r.querySelector('p').textContent = 'shadow clicked'); } });
console.error('fixture error');
fetch('/missing.json', { headers: { authorization: 'Bearer s3cret' } });
</script>`;
const frame = `<!doctype html><p id="out">frame</p><input aria-label="Frame input"><button onclick="out.textContent = 'got ' + document.querySelector('input').value">Frame button</button>`;

let main: ReturnType<typeof createServer>, other: ReturnType<typeof createServer>;
const port = (s: ReturnType<typeof createServer>) => (s.address() as { port: number }).port;
let chrome = true;
before(async () => {
  other = createServer((_, res) => res.end(frame)).listen(0, "127.0.0.1");
  main = createServer((req, res) => {
    if (req.url === "/") return res.setHeader("set-cookie", "sid=abc; Path=/"), res.end(page(`http://127.0.0.1:${port(other)}`));
    if (req.url === "/report.txt") return res.setHeader("content-disposition", "attachment; filename=report.txt"), res.end("data");
    res.statusCode = 404;
    res.end("nope");
  }).listen(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 50));
  chrome = await b.ensureBrowser().then(() => true, (e: Error) => (console.log("skipping:", e.message), false));
});
after(async () => {
  await b.closeBrowser();
  for (const s of [main, other]) s.closeAllConnections(), s.close();
});

test("scrub: credential fields masked in JSON, query strings and form bodies; the rest kept", () => {
  assert.equal(b.scrub('{"access_token": "abc.def", "user": "sam", "refresh_token":"x\\"y", "expires_in": 3600}'), '{"access_token": "[redacted]", "user": "sam", "refresh_token":"[redacted]", "expires_in": 3600}');
  assert.equal(b.scrub("https://x.com/cb?code=123&state=ok&id_token=zz#f"), "https://x.com/cb?code=[redacted]&state=ok&id_token=[redacted]#f");
  assert.equal(b.scrub("email=a%40b.com&password=hunter2&remember=1"), "email=a%40b.com&password=[redacted]&remember=1");
  assert.equal(b.scrub('{"csrfToken":123,"name":"pass"}'), '{"csrfToken":"[redacted]","name":"pass"}');
});

test("grants: scoped to ticket, agent, tab; a read grant never covers writes", () => {
  b.grant("t1", "a1", "tab1", "read");
  assert.equal(b.granted("t1", "a1", "tab1", "read"), true);
  assert.equal(b.granted("t1", "a1", "tab1", "write"), false);
  assert.equal(b.granted("t2", "a1", "tab1", "read"), false);
  b.grant("t1", "a1", "tab1", "write");
  assert.equal(b.granted("t1", "a1", "tab1", "write"), true);
});

test("tabs: snapshot, shadow DOM, cross-origin iframe, scroll, network, dialog, screenshot", async (t) => {
  if (!chrome) return t.skip("no Chromium-family browser installed");
  const tab = await b.openTab(`http://127.0.0.1:${port(main)}/`, { ticketId: "t1", agentId: "a1" });
  let snap = await b.settled(tab.id);
  assert.match(snap, /# Fixture/);
  assert.match(snap, /button "Shadow button" \[e\d+\]/);
  assert.match(snap, /--- frame http:\/\/127\.0\.0\.1:\d+\/frame/);
  const ref = (name: string) => snap.match(new RegExp(`"${name}" \\[(f?\\d*e\\d+)\\]`))![1]!;

  await b.act(tab.id, { click: ref("Shadow button") });
  assert.match(await b.readText(tab.id, undefined, 0, 5000), /shadow clicked/);

  snap = await b.snapshot(tab.id);
  await b.act(tab.id, { type: ref("Frame input"), text: "hi", clear: true, submit: false });
  snap = await b.act(tab.id, { click: ref("Frame button") });
  assert.match(await b.readText(tab.id, undefined, 0, 5000), /got hi/);

  assert.match(await b.scroll(tab.id, undefined, "bottom", 5), /Scrolled Messages bottom.*more content loaded 2×/);

  const net = await b.network(tab.id, { last: 50 });
  assert.match(net, /GET 200 document/);
  const miss = net.match(/#(\d+) \S+ GET 404 fetch/);
  assert.ok(miss, net);
  const detail = await b.requestDetail(tab.id, Number(miss[1]));
  assert.match(detail, /authorization: \[redacted\]/);
  assert.doesNotMatch(detail, /s3cret/);
  assert.match(await b.consoleLog(tab.id, "errors", 50, false), /fixture error/);

  snap = await b.snapshot(tab.id);
  void b.act(tab.id, { click: ref("Ask") }).catch(() => {}); // blocks until the dialog is answered
  await new Promise((r) => setTimeout(r, 500));
  assert.match(await b.snapshot(tab.id), /A confirm dialog is open: "Sure\?"/);
  await assert.rejects(b.readText(tab.id, undefined, 0, 100), /dialog is open/);
  assert.match(await b.answerDialog(tab.id, true), /Accepted/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.getTab(tab.id) && (await b.evalScript(tab.id, "return document.title")), '"yes"');

  const jpeg = Buffer.from(await b.screenshot(tab.id, false), "base64");
  assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");

  // Downloads wait for the user; saving never overwrites.
  for (let i = 0; i < 2; i++) {
    snap = await b.snapshot(tab.id);
    await b.act(tab.id, { click: ref("Get report") });
    for (let w = 0; w < 20 && b.browserState().downloads.length < 1; w++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(join(tmp, "downloads")) && readdirSync(join(tmp, "downloads")).length, i ? 1 : false); // nothing written yet
    assert.match(await b.snapshot(tab.id), /Downloads waiting for the user.*report\.txt/);
    await b.decideDownload(b.browserState().downloads[0]!.id, true);
  }
  assert.deepEqual(readdirSync(join(tmp, "downloads")).sort(), ["report (1).txt", "report.txt"]);
  if (process.platform === "darwin") assert.match(execFileSync("xattr", ["-p", "com.apple.quarantine", join(tmp, "downloads", "report.txt")], { encoding: "utf8" }), /;Zippy;/);

  // Viewer input: ⌘A arrives as one key event carrying its modifiers (no separate Meta keydown), then Backspace.
  await b.evalScript(tab.id, "const i = document.createElement('input'); i.id = 'q'; i.value = 'hello'; document.body.append(i); i.focus();");
  const sel = process.platform === "darwin" ? "Meta" : "Control";
  await b.input(tab.id, [{ t: "key", down: true, key: "a", mods: [sel] }, { t: "key", down: false, key: "a", mods: [sel] }, { t: "key", down: true, key: "Backspace" }, { t: "key", down: false, key: "Backspace" }, { t: "text", text: "ok" }]);
  assert.equal(await b.evalScript(tab.id, "return document.getElementById('q').value"), '"ok"');

  // Quitting keeps the tab; the next start brings it back with its id and owner.
  await b.closeBrowser();
  assert.equal(b.getTab(tab.id)?.agentId, "a1");
  await b.ensureBrowser();
  assert.match(await b.settled(tab.id), /# Fixture/);

  await b.closeTab(tab.id);
  assert.equal(b.getTab(tab.id), undefined);
});
