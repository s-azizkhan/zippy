import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseTags, procName } from "./term.ts";

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
