import assert from "node:assert/strict";
import { test } from "node:test";
import { render, similar, terms } from "./kb.ts";

test("terms", () => assert.deepEqual(terms("Use the pnpm CLI, not npm! for the API"), ["pnpm", "cli", "npm", "api"]));

test("similar", () => {
  assert.ok(similar("Run pnpm db:push after schema changes", "after schema changes run pnpm db:push"));
  assert.ok(!similar("Run pnpm db:push after schema changes", "Never commit .env files"));
});

test("render groups by kind", () =>
  assert.equal(
    render([
      { id: "bbbbbbbb-1", kind: "link", text: "Docs", url: "https://x.dev" },
      { id: "aaaaaaaa-1", kind: "dont", text: "Commit .env" },
    ] as never),
    "- [aaaaaaaa] Don't: Commit .env\n- [bbbbbbbb] Link: Docs <https://x.dev>",
  ));
