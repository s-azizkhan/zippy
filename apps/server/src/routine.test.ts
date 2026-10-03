import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRunAt } from "@zippy/shared";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

test("no runAt: lastRunAt + N hours", () => {
  const r = { everyHours: 6, runAt: null, lastRunAt: at(2026, 1, 1, 10), createdAt: at(2026, 1, 1, 8) };
  assert.deepEqual(nextRunAt(r), at(2026, 1, 1, 16));
});

test("runAt, never run: same day if still ahead, else next day", () => {
  const base = { everyHours: 24, runAt: "14:00", lastRunAt: null };
  assert.deepEqual(nextRunAt({ ...base, createdAt: at(2026, 1, 1, 10) }), at(2026, 1, 1, 14));
  assert.deepEqual(nextRunAt({ ...base, createdAt: at(2026, 1, 1, 15) }), at(2026, 1, 2, 14));
});

test("runAt, after a run: ceil(N/24) days later at HH:MM", () => {
  const r = { everyHours: 48, runAt: "09:30", lastRunAt: at(2026, 1, 1, 9, 31), createdAt: at(2025, 12, 1, 0) };
  assert.deepEqual(nextRunAt(r), at(2026, 1, 3, 9, 30));
});
