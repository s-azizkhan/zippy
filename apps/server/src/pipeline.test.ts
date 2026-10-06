import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCriteria, target } from "./pipeline.ts";

const stages = [0, 1, 2].map((position) => ({ id: `s${position}`, position, name: `S${position}` })) as Parameters<typeof target>[0];

test("stage routing refs", () => {
  assert.equal(target(stages, stages[0]!, "next"), stages[1]);
  assert.equal(target(stages, stages[2]!, "next"), "done"); // last stage
  assert.equal(target(stages, stages[2]!, "0"), stages[0]); // fail loop back
  assert.equal(target(stages, stages[1]!, "human"), "human");
  assert.equal(target(stages, stages[1]!, "9"), "human"); // dangling ref goes to a human
});

test("validator skip needs acceptance criteria in the body", () => {
  assert.equal(hasCriteria("Fix login.\n\n## Acceptance criteria\n- redirects home"), true);
  assert.equal(hasCriteria("Fix login."), false);
});
