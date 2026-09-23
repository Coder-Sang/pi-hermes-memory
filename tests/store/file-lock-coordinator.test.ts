import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { FileLockCoordinator } from "../../src/store/file-lock-coordinator.js";

describe("file lock coordinator", () => {
  it("excludes concurrent leases, renews and releases without SQLite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
    try {
      const a = FileLockCoordinator.shared(root);
      const b = new FileLockCoordinator(root);
      const lease = a.tryAcquire("same", { staleMs: 1000 });
      assert.ok(lease);
      assert.equal(b.tryAcquire("same", { staleMs: 1000 }), null);
      assert.equal(lease.renew(), true);
      lease.release();
      const second = b.tryAcquire("same", { staleMs: 1000 });
      assert.ok(second);
      assert.notEqual(second.token, lease.token);
      second.release();
      assert.equal(fs.readdirSync(root).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims an abandoned lock and fences the former holder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
    try {
      const coordinator = new FileLockCoordinator(root);
      const former = coordinator.tryAcquire("same", { staleMs: 100 });
      assert.ok(former);
      const lockDir = path.join(root, `${createHash("sha256").update("same").digest("hex")}.lock`);
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: former.token, pid: process.pid, timestamp: Date.now() - 5000 }));
      const current = coordinator.tryAcquire("same", { staleMs: 100 });
      assert.ok(current);
      assert.equal(former.renew(), false);
      former.release();
      assert.equal(current.renew(), true);
      current.release();
      assert.equal(fs.readdirSync(root).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
