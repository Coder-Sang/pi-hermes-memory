import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  publishFile, readFileSnapshot, removePublishedFile, preservedFilePaths,
} from "../../src/store/publish-file.js";

const ioError = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
let root: string;
let source: string;
let target: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "publish-file-test-"));
  source = path.join(root, "source");
  target = path.join(root, "target");
  await fs.writeFile(source, Buffer.from("abc雪".repeat(40_000)), { mode: 0o600 });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("publishFile", () => {
  it("uses a hard link without opening a copy and leaves source cleanup to the caller", async (t) => {
    const open = t.mock.method(fs, "open", async () => { throw new Error("unexpected copy"); });
    const identity = await publishFile(source, target);
    const sourceState = await fs.stat(source);
    assert.deepEqual(identity, { dev: sourceState.dev, ino: sourceState.ino });
    assert.equal((await fs.stat(target)).ino, sourceState.ino);
    assert.equal(open.mock.callCount(), 0);
    assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
  });

  for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"]) {
    it(`copies in chunks after ${code} and returns the target inode`, async (t) => {
      const link = t.mock.method(fs, "link", async () => { throw ioError(code); });
      const identity = await publishFile(source, target);
      const targetState = await fs.stat(target);
      assert.equal(link.mock.callCount(), 1);
      assert.deepEqual(identity, { dev: targetState.dev, ino: targetState.ino });
      assert.notEqual(targetState.ino, (await fs.stat(source)).ino);
      assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
      assert.equal(targetState.mode & 0o777, 0o600);
    });
  }

  for (const code of ["EEXIST", "ENOSPC", "EROFS", "EACCES", "EIO", "ENOENT"]) {
    it(`propagates ${code} without attempting a copy`, async (t) => {
      const error = ioError(code);
      t.mock.method(fs, "link", async () => { throw error; });
      const open = t.mock.method(fs, "open", async () => { throw new Error("unexpected copy"); });
      await assert.rejects(publishFile(source, target), (actual) => actual === error);
      assert.equal(open.mock.callCount(), 0);
      await assert.rejects(fs.stat(target), { code: "ENOENT" });
    });
  }

  for (const fallback of [false, true]) {
    it(`preserves an existing target (fallback=${fallback})`, async (t) => {
      if (fallback) t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
      await fs.writeFile(target, "external contents");
      await assert.rejects(publishFile(source, target), { code: "EEXIST" });
      assert.equal(await fs.readFile(target, "utf8"), "external contents");
    });
  }

  it("permits exactly one concurrent creator", async (t) => {
    t.mock.method(fs, "link", async () => { throw ioError("EXDEV"); });
    const otherSource = path.join(root, "other-source");
    await fs.writeFile(otherSource, "second creator");
    const results = await Promise.allSettled([publishFile(source, target), publishFile(otherSource, target)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "EEXIST");
    const winner = results[0].status === "fulfilled" ? source : otherSource;
    assert.deepEqual(await fs.readFile(target), await fs.readFile(winner));
  });

  for (const code of ["EPERM", "EACCES", "EROFS", "ENOSPC"]) {
    it(`propagates the fallback open error ${code} without retrying`, async (t) => {
      const originalOpen = fs.open;
      const error = ioError(code);
      const link = t.mock.method(fs, "link", async () => { throw ioError("EPERM"); });
      t.mock.method(fs, "open", async (file, ...args) => {
        if (file === target) throw error;
        return originalOpen(file, ...args);
      });
      await assert.rejects(publishFile(source, target), (actual) => actual === error);
      assert.equal(link.mock.callCount(), 1);
    });
  }

  it("handles short reads and short writes without losing bytes", async (t) => {
    t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
    const originalOpen = fs.open;
    let reads = 0;
    let writes = 0;
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (file === source) {
        const read = handle.read.bind(handle);
        t.mock.method(handle, "read", async (buffer, offset, length, position) => {
          reads++;
          assert.ok(length <= 64 * 1024);
          return read(buffer, offset, Math.min(length, 4000), position);
        });
      } else if (file === target) {
        const write = handle.write.bind(handle);
        t.mock.method(handle, "write", async (buffer, offset, length, position) => {
          writes++;
          return write(buffer, offset, Math.min(length, 997), position);
        });
      }
      return handle;
    });
    await publishFile(source, target);
    assert.ok(reads > 2);
    assert.ok(writes > reads);
    assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
  });

  for (const failure of ["read", "write", "zero-write", "close", "stat", "cleanup-stat", "unlink", "replaced"]) {
    it(`handles ${failure} failure without deleting unowned data`, async (t) => {
      t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
      const originalOpen = fs.open;
      const error = ioError(failure === "write" ? "ENOSPC" : "EIO");
      const handles: fs.FileHandle[] = [];
      let writes = 0;
      t.mock.method(fs, "open", async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        handles.push(handle);
        if (file === source && failure === "read") {
          const read = handle.read.bind(handle);
          let reads = 0;
          t.mock.method(handle, "read", async (...readArgs) => {
            if (++reads === 2) throw error;
            return read(...readArgs);
          });
        }
        if (file === target) {
          if (failure === "stat") t.mock.method(handle, "stat", async () => { throw error; });
          if (failure === "close") {
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => { await close(); throw error; });
          }
          const write = handle.write.bind(handle);
          t.mock.method(handle, "write", async (...writeArgs) => {
            writes++;
            if (failure === "zero-write") return { bytesWritten: 0, buffer: writeArgs[0] };
            if (writes === 2 && ["write", "cleanup-stat", "unlink", "replaced"].includes(failure)) {
              if (failure === "replaced") {
                await fs.rename(target, path.join(root, "displaced-partial"));
                await fs.writeFile(target, "external successor");
              }
              if (failure === "cleanup-stat") {
                const lstat = fs.lstat;
                t.mock.method(fs, "lstat", async (file, ...args) => {
                  if (String(file).includes(".publish-recovery-")) throw ioError("EACCES");
                  return lstat(file, ...args);
                });
              }
              if (failure === "unlink") t.mock.method(fs, "unlink", async () => { throw ioError("EACCES"); });
              throw error;
            }
            return write(...writeArgs);
          });
        }
        return handle;
      });
      let retainedPaths: string[] = [];
      await assert.rejects(publishFile(source, target), (actual: any) => {
        retainedPaths = preservedFilePaths(actual);
        assert.ok(actual === error || actual.cause === error || (failure === "zero-write" && actual.code === "EIO"));
        return true;
      });
      for (const handle of handles) assert.equal(handle.fd, -1, "every descriptor must be closed");
      if (["stat", "cleanup-stat", "unlink", "replaced"].includes(failure)) {
        const retained = await Promise.all(retainedPaths.map((file) => fs.stat(file).catch(() => null)));
        assert.ok(retained.some(Boolean), "keep recovery data when ownership/cleanup is uncertain");
        if (failure === "replaced") assert.equal(await fs.readFile(target, "utf8"), "external successor");
      } else {
        await assert.rejects(fs.stat(target), { code: "ENOENT" });
      }
      assert.ok((await fs.stat(source)).size > 0, "source must survive every failure");
    });
  }

  it("detects an external replacement even when all copy writes succeed", async (t) => {
    t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
    const originalOpen = fs.open;
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (file === target) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          await fs.rename(target, path.join(root, "displaced-copy"));
          await fs.writeFile(target, "external successor");
        });
      }
      return handle;
    });
    await assert.rejects(publishFile(source, target), /replaced during copy/);
    assert.equal(await fs.readFile(target, "utf8"), "external successor");
  });
});

describe("publication cleanup isolation", () => {
  for (const change of ["rewrite", "replace"]) {
    it(`rejects a file ${change} during fingerprinting`, async (t) => {
      await fs.copyFile(source, target);
      const open = fs.open;
      let injected = false;
      t.mock.method(fs, "open", async (file, ...args) => {
        const handle = await open(file, ...args);
        if (file === target && args[0] === "r") {
          const read = handle.read.bind(handle);
          t.mock.method(handle, "read", async (...readArgs) => {
            const result = await read(...readArgs);
            if (!injected) {
              injected = true;
              if (change === "replace") {
                await fs.rename(target, path.join(root, "old-inode"));
                await fs.copyFile(source, target);
              } else {
                const writer = await open(target, "r+");
                try { await writer.write(Buffer.from("xyz"), 0, 3, 0); }
                finally { await writer.close(); }
              }
            }
            return result;
          });
        }
        return handle;
      });
      await assert.rejects(readFileSnapshot(target), /File changed while/);
      assert.equal(injected, true);
    });
  }

  it("does not delete a successor created after the ownership check", async (t) => {
    t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
    const open = fs.open;
    let failed = false;
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === target && args[0] === "wx") {
        const write = handle.write.bind(handle);
        let count = 0;
        t.mock.method(handle, "write", async (...writeArgs) => {
          if (++count === 2) { failed = true; throw ioError("ENOSPC"); }
          return write(...writeArgs);
        });
      }
      return handle;
    });
    const lstat = fs.lstat;
    let injected = false;
    t.mock.method(fs, "lstat", async (file, ...args) => {
      const state = await lstat(file, ...args);
      if (failed && !injected && (file === target || String(file).includes(".publish-recovery-"))) {
        injected = true;
        if (file === target) await fs.rename(target, path.join(root, "old-partial"));
        await fs.writeFile(target, "external successor");
      }
      return state;
    });
    await assert.rejects(publishFile(source, target), { code: "ENOSPC" });
    assert.equal(injected, true);
    assert.equal(await fs.readFile(target, "utf8"), "external successor");
  });

  for (const timing of ["before-isolation", "after-isolation", "before-delete"]) {
    it(`preserves an external successor ${timing}`, async (t) => {
      await fs.copyFile(source, target);
      const snapshot = await readFileSnapshot(target);
      let injected = false;
      const rename = fs.rename;
      const replace = async () => {
        if (timing === "before-isolation") await rename(target, path.join(root, "owned"));
        await fs.writeFile(target, "external successor");
        injected = true;
      };
      t.mock.method(fs, "rename", async (from, to) => {
        if (from === target && timing === "before-isolation") await replace();
        await rename(from, to);
        if (from === target && timing === "after-isolation") await replace();
      });
      const unlink = fs.unlink;
      t.mock.method(fs, "unlink", async (file) => {
        if (String(file).includes(".publish-recovery-") && timing === "before-delete") await replace();
        return unlink(file);
      });
      if (timing === "before-isolation") {
        await assert.rejects(removePublishedFile(target, snapshot), /recovery files preserved at/);
      } else await removePublishedFile(target, snapshot);
      assert.equal(injected, true);
      assert.equal(await fs.readFile(target, "utf8"), "external successor");
    });
  }

  for (const failure of ["occupied", "restore", "isolate", "inspect"]) {
    it(`retains unrecognized contents when ${failure} prevents cleanup`, async (t) => {
      await fs.copyFile(source, target);
      const snapshot = await readFileSnapshot(target);
      await fs.writeFile(target, "external edit on the same inode");
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (from, to) => {
        if (failure === "isolate") throw ioError("EACCES");
        await rename(from, to);
        if (from === target && failure === "occupied") await fs.writeFile(target, "new creator");
      });
      if (failure === "restore") t.mock.method(fs, "link", async () => { throw ioError("EACCES"); });
      if (failure === "inspect") {
        const lstat = fs.lstat;
        t.mock.method(fs, "lstat", async (file, ...args) => {
          if (String(file).includes(".publish-recovery-")) throw ioError("EACCES");
          return lstat(file, ...args);
        });
      }
      let retained: string[] = [];
      await assert.rejects(removePublishedFile(target, snapshot), (error) => {
        retained = preservedFilePaths(error);
        return retained.length > 0;
      });
      const contents = await Promise.all(retained.map((file) => fs.readFile(file, "utf8").catch(() => "")));
      assert.ok(contents.includes("external edit on the same inode"));
      if (failure === "occupied") assert.equal(await fs.readFile(target, "utf8"), "new creator");
    });
  }

  it("preserves uncertain partial writes without recursive restoration cleanup", async (t) => {
    t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
    const open = fs.open;
    let creations = 0;
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === target && args[0] === "wx") {
        creations++;
        const write = handle.write.bind(handle);
        t.mock.method(handle, "write", async (buffer, offset, _length, position) => {
          await write(buffer, offset, 20, position);
          throw ioError("ENOSPC");
        });
      }
      return handle;
    });
    let retained: string[] = [];
    await assert.rejects(publishFile(source, target), (error) => {
      retained = preservedFilePaths(error);
      return retained.length > 0;
    });
    assert.equal(creations, 2, "one failed publication and one non-recursive restoration");
    const contents = await Promise.all(retained.map((file) => fs.readFile(file).catch(() => null)));
    assert.ok(contents.some((content) => content?.length === 20));
  });

  it("restores an unowned relative symlink without changing its meaning", async () => {
    await fs.copyFile(source, target);
    const snapshot = await readFileSnapshot(target);
    await fs.unlink(target);
    await fs.symlink("source", target);
    await assert.rejects(removePublishedFile(target, snapshot), /recovery files preserved at/);
    assert.equal(await fs.readlink(target), "source");
    assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
  });
});
