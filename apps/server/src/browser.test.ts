import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Script } from "node:vm";

process.env.ZIPPY_BRIDGE = "s3cret-s3cret-s3";
const b = await import("./browser.ts");

/** Plays the desktop shell until stopped: answers every job, checking each injected script at least parses. */
function shell(answer: (js: string) => unknown) {
  const seen: string[] = [];
  let on = true;
  const done = (async () => {
    while (on) {
      for (const job of await b.bridgePoll()) {
        seen.push(job.op);
        if (job.op === "eval") new Script(job.js); // throws SyntaxError on an escaping slip
        b.bridgeResult({ id: job.id, ok: true, value: job.op === "eval" ? JSON.stringify({ ok: true, v: answer(job.js) }) : null });
      }
    }
  })();
  return { seen, stop: () => ((on = false), b.bridgePoll(), done) }; // a fresh poll releases the hanging one
}

test("bridgeOk: only the shell's secret", () => {
  assert.equal(b.bridgeOk("s3cret-s3cret-s3"), true);
  assert.equal(b.bridgeOk("s3cret-s3cret-s4"), false);
  assert.equal(b.bridgeOk(undefined), false);
});

test("tab round trip: open, act, snapshot over the bridge", async () => {
  const snap = { title: "Inbox", url: "https://mail.example.com/", lines: ['button "Send" [e1]'], more: 0 };
  // settle() probe: answer "a fresh, loaded document", so actions return at once.
  const sh = shell((js) => (js.includes("document.readyState]") ? [null, 0, "complete"] : js.includes("lines.push") ? snap : js.includes("delete window.__zr") ? { done: true, s: "1" } : true));
  const t = await b.openTab("https://mail.example.com/", { ticketId: "t1", agentId: "a1" });
  assert.equal(b.getTab(t.id)?.agentId, "a1");
  b.bridgeEvent({ tab: t.id, title: "Inbox", loading: false }); // the shell reports the page loaded
  assert.equal(b.getTab(t.id)?.title, "Inbox");

  const out = await b.act(t.id, { type: "e1", text: `it's "quoted" \\ and\nmultiline`, clear: true, submit: true });
  assert.match(out, /button "Send" \[e1\]/);
  assert.match(out, /untrusted/);
  await b.act(t.id, { click: "e1" });
  await b.act(t.id, { press: "Meta+Enter" });
  await b.readText(t.id, "e1", 0, 100).catch(() => {}); // fake answer has the wrong shape; the script parsing is the point
  assert.equal(await b.evalScript(t.id, "return 1"), "1");
  await b.closeTab(t.id);
  await sh.stop();
  assert.equal(sh.seen[0], "open");
  assert.ok(sh.seen.filter((o) => o === "eval").length >= 8);
  assert.equal(b.getTab(t.id), undefined);
});
