import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { browse } from "./browse.ts";

const root = mkdtempSync(join(tmpdir(), "browse-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src/a.txt"), "hi");
symlinkSync(tmpdir(), join(root, "link"));

test("lists, reads, blocks escapes", async () => {
  assert.equal((await browse(root, "")).type, "dir");
  assert.equal(((await browse(root, "src/a.txt")) as { content: string }).content, "hi");
  await assert.rejects(browse(root, "../"), /Outside folder/);
  await assert.rejects(browse(root, "link"), /Outside folder/);
});

test("listFiles walks non-git dirs", async () => {
  const { listFiles } = await import("./browse.ts");
  assert.deepEqual(await listFiles(root), ["src/a.txt"]);
});
