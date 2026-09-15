import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const ioError = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
const names = { memory: "MEMORY.md", user: "USER.md", failure: "failures.md" } as const;
let root: string;
let memoryDir: string;
let store: MemoryStore;

beforeEach(async (t) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hardlink-test-"));
  memoryDir = path.join(root, "memory");
  store = new MemoryStore({ memoryDir, memoryMode: "policy-only", memoryCharLimit: 1000, userCharLimit: 1000 } as MemoryConfig);
  await store.loadFromDisk();
  t.mock.method(fs, "link", async () => { throw ioError("ENOTSUP"); });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function artifacts(prefix: string): Promise<string[]> {
  return Promise.all((await fs.readdir(memoryDir))
    .filter((name) => name.includes(prefix))
    .map((name) => fs.readFile(path.join(memoryDir, name), "utf8")));
}

function failVerification(readNumber: number): void {
  const read = (store as any).readFileState.bind(store);
  let displacedReads = 0;
  (store as any).readFileState = async (file: string) => {
    if (file.includes(".recovery-") && ++displacedReads === readNumber) throw ioError("EIO");
    return read(file);
  };
}

describe("MemoryStore without hard links", () => {
  for (const target of ["memory", "user", "failure"] as const) {
    it(`creates, appends, replaces and removes ${target}, observing final disk content`, async () => {
      const file = path.join(memoryDir, names[target]);
      const observed: string[][] = [];
      store.setMutationObserver(async (changedTarget, entries) => {
        assert.equal(changedTarget, target);
        assert.equal(entries.join(ENTRY_DELIMITER), await fs.readFile(file, "utf8"));
        observed.push(entries);
      });
      assert.equal((await store.add(target, "original")).success, true);
      const original = await fs.readFile(file, "utf8");
      assert.equal((await store.add(target, "appended")).success, true);
      assert.deepEqual(await artifacts(`.${names[target]}.recovery-`), [original]);
      assert.equal((await store.replace(target, "original", "replacement")).success, true);
      assert.equal((await store.remove(target, "appended")).success, true);
      assert.equal((await store.remove(target, "replacement")).success, true);
      assert.equal(await fs.readFile(file, "utf8"), "");
      assert.equal(observed.length, 5);
    });

    for (const readNumber of [1, 2]) {
      it(`restores ${target} when verification ${readNumber} fails, including a copied-inode rollback`, async () => {
        const file = path.join(memoryDir, names[target]);
        await store.add(target, "original");
        const original = await fs.readFile(file, "utf8");
        failVerification(readNumber);
        const observed: string[][] = [];
        store.setMutationObserver(async (_target, entries) => { observed.push(entries); });
        await assert.rejects(store.add(target, "failed addition"), { code: "EIO" });
        assert.equal(await fs.readFile(file, "utf8"), original);
        assert.deepEqual(await artifacts(`.${names[target]}.recovery-`), [original]);
        assert.deepEqual(observed, [[original]]);
      });
    }
  }

  it("serializes concurrent creation and keeps both mutations", async () => {
    const other = new MemoryStore({ memoryDir, memoryMode: "policy-only" } as MemoryConfig);
    await other.loadFromDisk();
    const results = await Promise.all([store.add("memory", "first"), other.add("memory", "second")]);
    assert.ok(results.every((result) => result.success));
    const raw = await fs.readFile(path.join(memoryDir, names.memory), "utf8");
    assert.match(raw, /first/);
    assert.match(raw, /second/);
  });

  it("retries against an external file created between the link attempt and exclusive open", async (t) => {
    let injected = false;
    t.mock.method(fs, "link", async (_source, target) => {
      if (!injected) {
        injected = true;
        await fs.writeFile(target, "external creator");
      }
      throw ioError("EPERM");
    });
    const result = await store.add("memory", "local addition");
    assert.equal(result.success, true);
    const raw = await fs.readFile(path.join(memoryDir, names.memory), "utf8");
    assert.match(raw, /external creator/);
    assert.match(raw, /local addition/);
  });

  it("cleans a partial failed write, restores the original and allows a retry", async (t) => {
    const file = path.join(memoryDir, names.memory);
    await store.add("memory", "original");
    const original = await fs.readFile(file, "utf8");
    const open = fs.open;
    let injected = false;
    t.mock.method(fs, "open", async (filePath, ...args) => {
      const handle = await open(filePath, ...args);
      if (path.basename(String(filePath)) === names.memory && args[0] === "wx" && !injected) {
        injected = true;
        const write = handle.write.bind(handle);
        let writes = 0;
        t.mock.method(handle, "write", async (...writeArgs) => {
          if (++writes === 2) throw ioError("ENOSPC");
          return write(...writeArgs);
        });
      }
      return handle;
    });
    await assert.rejects(store.add("memory", "x".repeat(150_000)), { code: "ENOSPC" });
    assert.equal(await fs.readFile(file, "utf8"), original);
    assert.deepEqual(await artifacts(".recovery-"), [original]);
    assert.equal((await store.add("memory", "retry")).success, true);
    assert.match(await fs.readFile(file, "utf8"), /retry/);
  });

  it("retains recovery data when both publication and restoration fail", async (t) => {
    const file = path.join(memoryDir, names.memory);
    await store.add("memory", "original");
    const original = await fs.readFile(file, "utf8");
    const open = fs.open;
    t.mock.method(fs, "open", async (filePath, ...args) => {
      if (path.basename(String(filePath)) === names.memory && args[0] === "wx") throw ioError("ENOSPC");
      return open(filePath, ...args);
    });
    const observed: string[][] = [];
    store.setMutationObserver(async (_target, entries) => { observed.push(entries); });
    await assert.rejects(store.add("memory", "failed"), { code: "ENOSPC" });
    assert.deepEqual(await artifacts(".recovery-"), [original]);
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
    assert.deepEqual(observed, [[]]);
  });

  it("keeps the original and copied mutation when post-publication rollback fails", async (t) => {
    const file = path.join(memoryDir, names.memory);
    await store.add("memory", "original");
    failVerification(2);
    t.mock.method(fs, "link", async (source) => {
      if (String(source).includes(".recovery-")) throw ioError("EACCES");
      throw ioError("ENOTSUP");
    });
    await assert.rejects(store.add("memory", "failed addition"), { code: "EACCES" });
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
    assert.ok((await artifacts(".recovery-")).some((raw) => raw.includes("original")));
    assert.ok((await artifacts(".conflict-")).some((raw) => raw.includes("failed addition")));
  });

  it("restores an external successor displaced during rollback", async () => {
    const file = path.join(memoryDir, names.memory);
    await store.add("memory", "original");
    failVerification(2);
    (store as any).preserveConflictFile = async () => {
      await fs.rename(file, path.join(root, "local-copy"));
      await fs.writeFile(file, "external successor");
    };
    await assert.rejects(store.add("memory", "failed"), { code: "EIO" });
    assert.equal(await fs.readFile(file, "utf8"), "external successor");
    assert.ok((await artifacts(".recovery-")).some((raw) => raw.includes("original")));
    assert.ok((await artifacts(".conflict-")).includes("external successor"));
  });

  it("reports external replacement during copying and observes the preserved successor", async (t) => {
    const file = path.join(memoryDir, names.memory);
    await store.add("memory", "original");
    const open = fs.open;
    let injected = false;
    t.mock.method(fs, "open", async (filePath, ...args) => {
      const handle = await open(filePath, ...args);
      if (path.basename(String(filePath)) === names.memory && args[0] === "wx" && !injected) {
        injected = true;
        const write = handle.write.bind(handle);
        t.mock.method(handle, "write", async (...writeArgs) => {
          await fs.rename(file, path.join(root, "partial-copy"));
          await fs.writeFile(file, "external successor");
          return write(...writeArgs);
        });
      }
      return handle;
    });
    const observed: string[][] = [];
    store.setMutationObserver(async (_target, entries) => { observed.push(entries); });
    await assert.rejects(store.add("memory", "failed"), /replaced during copy/);
    assert.equal(await fs.readFile(file, "utf8"), "external successor");
    assert.deepEqual(observed, [["external successor"]]);
    assert.ok((await artifacts(".recovery-")).some((raw) => raw.includes("original")));
  });

  it("retries an external truncate after publication and observes the final disk", async () => {
    const file = path.join(memoryDir, names.memory);
    const save = (store as any).saveToDisk.bind(store);
    let injected = false;
    (store as any).saveToDisk = async (target: string) => {
      await save(target);
      if (!injected) {
        injected = true;
        await fs.writeFile(file, "external rewrite");
      }
    };
    const observed: string[][] = [];
    store.setMutationObserver(async (_target, entries) => { observed.push(entries); });
    assert.equal((await store.add("memory", "local addition")).success, true);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].join(ENTRY_DELIMITER), await fs.readFile(file, "utf8"));
    assert.match(observed[0].join("\n"), /external rewrite/);
    assert.match(observed[0].join("\n"), /local addition/);
  });
});
