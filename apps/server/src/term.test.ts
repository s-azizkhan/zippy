import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseTags } from "./term.ts";

test("parseTags: @handles and ticket ids from a title, nothing else", () => {
  assert.deepEqual(parseTags("@executor ZIP-12 dev server"), ["@executor", "ZIP-12"]);
  assert.deepEqual(parseTags("mail@host.com zsh 3 ABC-1x"), []);
  assert.deepEqual(parseTags("ZIP-12 ZIP-12"), ["ZIP-12"]);
});
