import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claudeHook, closeTerminal, getTerminal, parseTags, procName, spawnTerminal, transcriptTitle, watched, withHooks } from "./term.ts";

test("parseTags: @handles and ticket ids from a title, nothing else", () => {
  assert.deepEqual(parseTags("@executor ZIP-12 dev server"), ["@executor", "ZIP-12"]);
  assert.deepEqual(parseTags("mail@host.com zsh 3 ABC-1x"), []);
  assert.deepEqual(parseTags("ZIP-12 ZIP-12"), ["ZIP-12"]);
});

test("procName: native Claude Code's version-named binary reads as claude", () => {
  assert.equal(procName("2.1.296"), "claude");
  assert.equal(procName("/bin/zsh"), "zsh");
  assert.equal(procName("node"), "node");
});

test("transcriptTitle: custom > AI title > first real prompt", () => {
  const user = (content: unknown, extra = {}) => JSON.stringify({ type: "user", message: { content }, ...extra });
  const meta = user("<local-command-caveat>Caveat: ignore</local-command-caveat>", { isMeta: true });
  assert.equal(transcriptTitle([meta, user("<command-name>/x</command-name>"), user([{ type: "text", text: "fix login\nmore" }])].join("\n"), ""), "fix login");
  assert.equal(transcriptTitle(user("<command-name>/caveman</command-name><command-args>polish ui</command-args>"), ""), "polish ui");
  assert.equal(transcriptTitle(user("first"), JSON.stringify({ type: "ai-title", aiTitle: "AI" })), "AI");
  assert.equal(transcriptTitle(JSON.stringify({ type: "custom-title", customTitle: "Mine" }), JSON.stringify({ type: "ai-title", aiTitle: "AI" }) + "\n{broken"), "Mine");
  assert.equal(transcriptTitle(meta, ""), "");
});

test("claudeHook: prompt names an untitled shell once; only permission prompts mean waiting", () => {
  const t = spawnTerminal("ws", process.cwd());
  try {
    assert.equal(claudeHook(t.id, { hook_event_name: "SessionStart", session_id: "s1" })?.next, "ready");
    claudeHook(t.id, { hook_event_name: "UserPromptSubmit", prompt: "fix the login redirect\nplease" });
    assert.equal(getTerminal(t.id)!.title, "fix the login redirect");
    claudeHook(t.id, { hook_event_name: "UserPromptSubmit", prompt: "second" });
    assert.equal(getTerminal(t.id)!.title, "fix the login redirect");
    assert.equal(claudeHook(t.id, { hook_event_name: "Notification", notification_type: "idle_prompt" })?.next, "working");
    assert.equal(claudeHook(t.id, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })?.next, "waiting");
    assert.equal(claudeHook(t.id, { hook_event_name: "PostToolUse" })?.next, "working");
    assert.equal(claudeHook(t.id, { hook_event_name: "Stop" })?.next, "done");
    assert.equal(claudeHook(t.id, { hook_event_name: "SessionEnd" })?.next, null);
    assert.equal(withHooks("claude -c").startsWith("claude --settings "), true);
    assert.equal(withHooks("claudette"), "claudette");
    // Banners only fire for shells nobody has on screen (no open output stream).
    assert.equal(watched(t.id), false);
    const off = () => {};
    getTerminal(t.id)!.events.on("data", off);
    assert.equal(watched(t.id), true);
    getTerminal(t.id)!.events.off("data", off);
  } finally {
    closeTerminal(t.id);
  }
});
