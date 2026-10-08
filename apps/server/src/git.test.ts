import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchInfo, checkout, commitFiles, isRisky, setIdentity } from "./git.ts";

test("risk paths match by prefix or glob", () => {
  const rules = ["src/payments", "**/migrations/**", ".env*"];
  assert.equal(isRisky("src/payments/charge.ts", rules), true);
  assert.equal(isRisky("src/payments-ui/x.ts", rules), false); // prefix is per path segment
  assert.equal(isRisky("database/migrations/2026_add.php", rules), true);
  assert.equal(isRisky(".env.local", rules), true);
  assert.equal(isRisky("src/app.ts", rules), false);
});

test("status, partial commit with rename + delete, stash & switch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zippy-git-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    for (const f of ["a", "b", "z"]) writeFileSync(join(dir, `${f}.txt`), f);
    git("add", ".");
    git("commit", "-qm", "init");
    git("branch", "other");
    writeFileSync(join(dir, "a.txt"), "dirty");
    git("mv", "b.txt", "c.txt");
    unlinkSync(join(dir, "z.txt"));
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "d/new.txt"), "n");

    const info = await branchInfo(dir);
    assert.deepEqual(info!.changes, [
      { path: "a.txt", status: "M" }, // leading-space status must survive
      { path: "c.txt", status: "R", orig: "b.txt" },
      { path: "z.txt", status: "D" },
      { path: "d/new.txt", status: "?" },
    ]);
    await commitFiles(dir, "rename + delete", ["c.txt", "z.txt"]);
    assert.deepEqual((await branchInfo(dir))!.changes.map((c) => c.path), ["a.txt", "d/new.txt"]);
    await assert.rejects(commitFiles(dir, "x", ["nope"]));
    await assert.rejects(checkout(dir, "--orphan=x"), /Unknown branch/);

    await checkout(dir, "other", true);
    const after = await branchInfo(dir);
    assert.equal(after!.current, "other");
    assert.equal(after!.stashes, 1);
    assert.equal(after!.changes.length, 0);

    assert.deepEqual(after!.identity, { name: "t", email: "t@t", local: true });
    await setIdentity(dir, "Ada", "ada@x.dev");
    assert.deepEqual((await branchInfo(dir))!.identity, { name: "Ada", email: "ada@x.dev", local: true });
    await setIdentity(dir, "", "");
    assert.equal((await branchInfo(dir))!.identity.local, false); // override gone, global (if any) shows through
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
