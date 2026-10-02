import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketPatch } from "@zippy/shared";

test("PATCH schema does not inject defaults", () => {
  assert.deepEqual(ticketPatch.parse({ title: "x" }), { title: "x" });
});
