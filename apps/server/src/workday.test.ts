import assert from "node:assert/strict";
import { test } from "node:test";
import { workDay } from "@zippy/shared";

const at = (h: number, m = 0) => new Date(2026, 0, 2, h, m);

test("day rolls over at dayStart", () => {
  assert.equal(workDay(at(5, 59), "06:00"), "2026-01-01");
  assert.equal(workDay(at(6, 0), "06:00"), "2026-01-02");
  assert.equal(workDay(at(9, 59), "10:00"), "2026-01-01");
  assert.equal(workDay(at(0, 0), "00:00"), "2026-01-02");
});
