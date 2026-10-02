import assert from "node:assert/strict";
import { test } from "node:test";
import { isRisky } from "./git.ts";

test("risk paths match by prefix or glob", () => {
  const rules = ["src/payments", "**/migrations/**", ".env*"];
  assert.equal(isRisky("src/payments/charge.ts", rules), true);
  assert.equal(isRisky("src/payments-ui/x.ts", rules), false); // prefix is per path segment
  assert.equal(isRisky("database/migrations/2026_add.php", rules), true);
  assert.equal(isRisky(".env.local", rules), true);
  assert.equal(isRisky("src/app.ts", rules), false);
});
