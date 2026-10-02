import assert from "node:assert/strict";
import { test } from "node:test";
import { appendLearning } from "./tickets.ts";

test("appendLearning", () => {
  assert.equal(appendLearning("", "a"), "## Learnings\n- a");
  assert.equal(appendLearning("Intro", "a\nb"), "Intro\n\n## Learnings\n- a b");
  assert.equal(appendLearning("## Learnings\n- a\n", "b"), "## Learnings\n- a\n- b");
  assert.equal(appendLearning("## Learnings\n- a\n\n## Other\nx", "b"), "## Learnings\n- a\n- b\n\n## Other\nx");
});
