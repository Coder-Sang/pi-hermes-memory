import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireMarkdownMutationLock, withMarkdownMutationLock } from "../../src/store/markdown-mutation-lock.js";

describe("markdown mutation lock", () => {
  it("preserves a committed result and releases before the next acquire", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-test-"));
    try {
      const file = path.join(dir, "memory", "MEMORY.md");
      assert.equal(await withMarkdownMutationLock(file, async () => "committed"), "committed");
      assert.equal(await withMarkdownMutationLock(file, async () => "next mutation"), "next mutation");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes another writer while the first holds its lease", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-test-"));
    try {
      const file = path.join(dir, "memory", "MEMORY.md");
      const first = await acquireMarkdownMutationLock(file);
      let acquired = false;
      const second = acquireMarkdownMutationLock(file).then((lease) => { acquired = true; lease.release(); });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(acquired, false);
      first.release();
      await second;
      assert.equal(acquired, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
