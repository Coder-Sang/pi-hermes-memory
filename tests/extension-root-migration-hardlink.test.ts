import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateExtensionRoot, isDatabaseMigrationPending } from "../src/extension-root-migration.js";

const ioError = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
const nativeLink = fs.link;
let root: string;
let legacy: string;
let target: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "migration-hardlink-test-"));
  legacy = path.join(root, "legacy");
  target = path.join(root, "target");
  await fs.mkdir(legacy);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function seedDatabase(): void {
  const db = new Database(path.join(legacy, "sessions.db"));
  try {
    db.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
  } finally { db.close(); }
}

function assertDatabase(directory: string): void {
  const db = new Database(path.join(directory, "sessions.db"), { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(db.prepare("SELECT value FROM retained").all(), [{ value: "legacy" }]);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally { db.close(); }
}

async function retirementDirs(): Promise<string[]> {
  return (await fs.readdir(legacy)).filter((name) => name.startsWith(".sessions-db-retirement-"));
}

for (const fallbackCode of ["ENOTSUP", "EMLINK"]) describe(`extension-root migration after ${fallbackCode}`, () => {
  beforeEach((t) => {
    t.mock.method(fs, "link", async () => { throw ioError(fallbackCode); });
  });

  it("migrates a consistent WAL snapshot and keeps the pending marker throughout copying", async (t) => {
    const source = new Database(path.join(legacy, "sessions.db"));
    try {
      source.pragma("journal_mode = WAL");
      source.pragma("wal_autocheckpoint = 0");
      source.exec("CREATE TABLE retained (value TEXT)");
      source.pragma("wal_checkpoint(TRUNCATE)");
      source.exec("INSERT INTO retained VALUES ('legacy')");
      const open = fs.open;
      let writes = 0;
      t.mock.method(fs, "open", async (file, ...args) => {
        const handle = await open(file, ...args);
        if (file === path.join(target, "sessions.db")) {
          const write = handle.write.bind(handle);
          t.mock.method(handle, "write", async (...writeArgs) => {
            writes++;
            assert.equal(isDatabaseMigrationPending(legacy, target), true);
            assert.equal(existsSync(path.join(target, ".sessions-db-migration-pending")), true);
            const result = await write(...writeArgs);
            assert.equal(isDatabaseMigrationPending(legacy, target), true);
            return result;
          });
        }
        return handle;
      });
      const result = await migrateExtensionRoot(legacy, target);
      assert.deepEqual(result.criticalFailures, []);
      assert.ok(writes > 0);
      assertDatabase(target);
      assert.equal(isDatabaseMigrationPending(legacy, target), false);
      for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
        assert.equal(existsSync(path.join(legacy, name)), false);
      }
    } finally { source.close(); }
  });

  it("preserves the exact corrupt database and sidecar bytes", async () => {
    const contents = {
      "sessions.db": "not sqlite".repeat(30_000),
      "sessions.db-wal": "raw wal",
      "sessions.db-shm": "raw shm",
    };
    for (const [name, content] of Object.entries(contents)) await fs.writeFile(path.join(legacy, name), content);
    const result = await migrateExtensionRoot(legacy, target);
    assert.deepEqual(result.criticalFailures, []);
    for (const [name, content] of Object.entries(contents)) {
      assert.equal(await fs.readFile(path.join(target, name), "utf8"), content);
      assert.equal(existsSync(path.join(legacy, name)), false);
    }
    assert.equal(isDatabaseMigrationPending(legacy, target), false);
  });

  for (const failure of ["retire", "publish", "partial-copy"]) {
    it(`restores a valid database after ${failure} failure and supports retry`, async (t) => {
      seedDatabase();
      const open = fs.open;
      let partialWrites = 0;
      if (failure === "partial-copy") {
        t.mock.method(fs, "open", async (file, ...args) => {
          const handle = await open(file, ...args);
          if (file === path.join(target, "sessions.db")) {
            const write = handle.write.bind(handle);
            t.mock.method(handle, "write", async (buffer, offset, length, position) => {
              if (++partialWrites === 2) throw ioError("ENOSPC");
              return write(buffer, offset, Math.min(length, 64), position);
            });
          }
          return handle;
        });
      }
      const result = await migrateExtensionRoot(legacy, target, {
        ...(failure === "retire" ? {
          retireDatabaseFile: async (source: string, destination: string) => {
            await fs.rename(source, destination);
            throw ioError("EIO");
          },
        } : {}),
        ...(failure === "publish" ? { publishDatabaseFile: async () => { throw ioError("EIO"); } } : {}),
      });
      assert.equal(result.criticalFailures.length, 1);
      assert.match(result.criticalFailures[0].message, failure === "partial-copy" ? /ENOSPC/ : /EIO/);
      assertDatabase(legacy);
      assert.equal(existsSync(path.join(target, "sessions.db")), false);
      assert.equal(existsSync(path.join(target, ".sessions-db-migration-pending")), false);
      assert.deepEqual(await retirementDirs(), []);
      t.mock.restoreAll();
      t.mock.method(fs, "link", async () => { throw ioError(fallbackCode); });
      const retried = await migrateExtensionRoot(legacy, target);
      assert.deepEqual(retried.criticalFailures, []);
      assertDatabase(target);
    });
  }

  it("closes its SQLite transaction and connection before restoring copies", async (t) => {
    seedDatabase();
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    let locked: Database.Database | undefined;
    let closed = false;
    let rolledBack = false;
    t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && this.name === path.join(legacy, "sessions.db")) locked = this;
      if (this === locked && sql === "ROLLBACK") rolledBack = true;
      return exec.call(this, sql);
    });
    t.mock.method(Database.prototype, "close", function (this: Database.Database) {
      const result = close.call(this);
      if (this === locked) closed = true;
      return result;
    });
    let restored = false;
    t.mock.method(fs, "link", async (_source, destination) => {
      if (destination === path.join(legacy, "sessions.db")) {
        restored = true;
        assert.equal(closed, true);
        assert.equal(rolledBack, true);
      }
      throw ioError(fallbackCode);
    });
    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async () => { throw ioError("ENOSPC"); },
    });
    assert.equal(result.criticalFailures.length, 1);
    assert.equal(restored, true);
    assertDatabase(legacy);
  });

  it("preserves recovery files if its SQLite connection cannot close before restoration", async (t) => {
    seedDatabase();
    const close = Database.prototype.close;
    const exec = Database.prototype.exec;
    let locked: Database.Database | undefined;
    t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && this.name === path.join(legacy, "sessions.db")) locked = this;
      return exec.call(this, sql);
    });
    let failed = false;
    t.mock.method(Database.prototype, "close", function (this: Database.Database) {
      if (this === locked && !failed) {
        failed = true;
        throw ioError("EIO");
      }
      return close.call(this);
    });
    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async () => { throw ioError("ENOSPC"); },
    });
    assert.equal(result.criticalFailures.length, 1);
    assert.match(result.criticalFailures[0].message, /could not close SQLite/);
    assert.equal(existsSync(path.join(legacy, "sessions.db")), false);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    const dirs = await retirementDirs();
    assert.equal(dirs.length, 1);
    assertDatabase(path.join(legacy, dirs[0]));
  });

  it("rolls back copied sidecars when a later corrupt-generation file fails", async (t) => {
    const contents = { "sessions.db": "not sqlite", "sessions.db-wal": "wal", "sessions.db-shm": "shm" };
    for (const [name, content] of Object.entries(contents)) await fs.writeFile(path.join(legacy, name), content);
    const open = fs.open;
    t.mock.method(fs, "open", async (file, ...args) => {
      if (file === path.join(target, "sessions.db")) throw ioError("ENOSPC");
      return open(file, ...args);
    });
    const result = await migrateExtensionRoot(legacy, target);
    assert.equal(result.criticalFailures.length, 1);
    for (const [name, content] of Object.entries(contents)) {
      assert.equal(await fs.readFile(path.join(legacy, name), "utf8"), content);
      assert.equal(existsSync(path.join(target, name)), false);
    }
  });

  it("does not overwrite a destination created during retirement", async () => {
    seedDatabase();
    const result = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.rename(source, destination);
        await fs.writeFile(path.join(target, "sessions.db"), "external database");
      },
    });
    assert.equal(result.criticalFailures.length, 1);
    assert.equal(await fs.readFile(path.join(target, "sessions.db"), "utf8"), "external database");
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    assertDatabase(legacy);
  });

  it("preserves an external sidecar replacement during rollback", async (t) => {
    await fs.writeFile(path.join(legacy, "sessions.db"), "not sqlite");
    await fs.writeFile(path.join(legacy, "sessions.db-wal"), "original wal");
    const open = fs.open;
    t.mock.method(fs, "open", async (file, ...args) => {
      if (file === path.join(target, "sessions.db")) {
        await fs.rename(path.join(target, "sessions.db-wal"), path.join(root, "owned-wal"));
        await fs.writeFile(path.join(target, "sessions.db-wal"), "external wal");
        throw ioError("ENOSPC");
      }
      return open(file, ...args);
    });
    const result = await migrateExtensionRoot(legacy, target);
    assert.equal(result.criticalFailures.length, 1);
    assert.equal(await fs.readFile(path.join(target, "sessions.db-wal"), "utf8"), "external wal");
    assert.equal(existsSync(path.join(target, ".sessions-db-migration-pending")), true);
    assert.equal(await fs.readFile(path.join(legacy, "sessions.db-wal"), "utf8"), "original wal");
  });

  it("keeps recovery data and the marker after a partial copy and failed restoration, including retry", async (t) => {
    seedDatabase();
    const open = fs.open;
    t.mock.method(fs, "open", async (file, ...args) => {
      if (file === path.join(legacy, "sessions.db") && args[0] === "wx") throw ioError("EROFS");
      const handle = await open(file, ...args);
      if (file === path.join(target, "sessions.db")) {
        const write = handle.write.bind(handle);
        t.mock.method(handle, "write", async (buffer, offset, length, position) => {
          await write(buffer, offset, Math.min(length, 64), position);
          throw ioError("ENOSPC");
        });
      }
      return handle;
    });
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (file) => {
      if (file === path.join(target, "sessions.db")) throw ioError("EACCES");
      return unlink(file);
    });
    const result = await migrateExtensionRoot(legacy, target);
    assert.equal(result.criticalFailures.length, 1);
    assert.match(result.criticalFailures[0].message, /ENOSPC.*recovery artifacts preserved/);
    const dirs = await retirementDirs();
    assert.equal(dirs.length, 1);
    assertDatabase(path.join(legacy, dirs[0]));
    assert.equal((await fs.stat(path.join(target, "sessions.db"))).size, 64);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    const retried = await migrateExtensionRoot(legacy, target);
    assert.equal(retried.criticalFailures.length, 1);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    assertDatabase(path.join(legacy, dirs[0]));
  });

  it("retains recovery data when even inspecting a held file fails", async (t) => {
    seedDatabase();
    const lstat = fs.lstat;
    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async () => {
        t.mock.method(fs, "lstat", async (file, ...args) => {
          if (String(file).includes(".sessions-db-retirement-")) throw ioError("EACCES");
          return lstat(file, ...args);
        });
        throw ioError("ENOSPC");
      },
    });
    assert.equal(result.criticalFailures.length, 1);
    assert.match(result.criticalFailures[0].message, /ENOSPC.*recovery artifacts preserved.*EACCES/);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    const dirs = await retirementDirs();
    assert.equal(dirs.length, 1);
    assertDatabase(path.join(legacy, dirs[0]));
  });

  for (const fail of [false, true]) {
    it(`preserves symlink semantics when migration ${fail ? "rolls back" : "succeeds"}`, async () => {
      seedDatabase();
      const external = path.join(root, "external.db");
      await fs.rename(path.join(legacy, "sessions.db"), external);
      await fs.symlink("../external.db", path.join(legacy, "sessions.db"));
      const result = await migrateExtensionRoot(legacy, target, fail ? {
        publishDatabaseFile: async () => { throw ioError("EIO"); },
      } : {});
      assert.equal(result.criticalFailures.length, fail ? 1 : 0);
      const directory = fail ? legacy : target;
      assert.equal((await fs.lstat(path.join(directory, "sessions.db"))).isSymbolicLink(), true);
      assertDatabase(directory);
    });
  }

  for (const mode of ["truncate", "same-size", "append"]) {
    for (const injectedPublisher of [false, true]) {
      it(`rejects ${mode} edits without losing the original (custom publisher=${injectedPublisher})`, async (t) => {
        seedDatabase();
        const seed = new Database(path.join(legacy, "sessions.db"));
        seed.exec("CREATE TABLE padding (value BLOB); INSERT INTO padding VALUES (zeroblob(400000))");
        seed.close();
        const destination = path.join(target, "sessions.db");
        const open = fs.open;
        let edited = false;
        const edit = async () => {
          if (edited) return;
          edited = true;
          if (mode === "truncate") await fs.writeFile(destination, "external rewrite");
          else if (mode === "append") await fs.appendFile(destination, "external suffix");
          else {
            const handle = await open(destination, "r+");
            try { await handle.write(Buffer.from("external rewrite"), 0, 16, 0); }
            finally { await handle.close(); }
          }
        };
        if (!injectedPublisher) {
          t.mock.method(fs, "open", async (file, ...args) => {
            const handle = await open(file, ...args);
            if (file === destination && args[0] === "wx") {
              const write = handle.write.bind(handle);
              t.mock.method(handle, "write", async (...writeArgs) => {
                const result = await write(...writeArgs);
                // Appending after the full copy prevents later chunks from
                // legitimately replacing the injected suffix.
                if (mode !== "append") await edit();
                return result;
              });
              if (mode === "append") {
                const close = handle.close.bind(handle);
                t.mock.method(handle, "close", async () => { await close(); await edit(); });
              }
            }
            return handle;
          });
        }
        const result = await migrateExtensionRoot(legacy, target, injectedPublisher ? {
          publishDatabaseFile: async (source, dest) => {
            await fs.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
            await edit();
          },
        } : {});
        assert.equal(edited, true);
        assert.equal(result.moved, 0);
        assert.equal(result.criticalFailures.length, 1);
        assert.match(result.criticalFailures[0].message, /content changed/);
        assert.match(result.criticalFailures[0].message, /\.publish-recovery-/);
        assert.equal(isDatabaseMigrationPending(legacy, target), true);
        assertDatabase(legacy);
        const dirs = await retirementDirs();
        assert.equal(dirs.length, 1);
        assertDatabase(path.join(legacy, dirs[0]));
        const retry = await migrateExtensionRoot(legacy, target);
        assert.equal(retry.criticalFailures.length, 1);
        assert.equal(isDatabaseMigrationPending(legacy, target), true);
      });
    }
  }

  for (const hardlinks of [false, true]) {
    it(`rechecks earlier sidecars and retains independent recovery bytes (hard links=${hardlinks})`, async (t) => {
      if (hardlinks) t.mock.method(fs, "link", nativeLink);
      await fs.writeFile(path.join(legacy, "sessions.db"), "not sqlite");
      await fs.writeFile(path.join(legacy, "sessions.db-wal"), "original wal");
      const result = await migrateExtensionRoot(legacy, target, {
        publishDatabaseFile: async (source, dest) => {
          if (hardlinks) await fs.link(source, dest);
          else await fs.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
          if (dest === path.join(target, "sessions.db")) {
            await fs.writeFile(path.join(target, "sessions.db-wal"), "external wal");
          }
        },
      });
      assert.equal(result.criticalFailures.length, 1);
      assert.match(result.criticalFailures[0].message, /content changed/);
      assert.equal(await fs.readFile(path.join(target, "sessions.db-wal"), "utf8"), "external wal");
      assert.equal(await fs.readFile(path.join(legacy, "sessions.db-wal"), "utf8"), "original wal");
      const dirs = await retirementDirs();
      assert.equal(await fs.readFile(path.join(legacy, dirs[0], "sessions.db-wal"), "utf8"), "original wal");
      assert.equal(isDatabaseMigrationPending(legacy, target), true);
    });
  }

  it("preserves an external successor created after rollback checks the isolated file", async (t) => {
    await fs.writeFile(path.join(legacy, "sessions.db"), "not sqlite");
    await fs.writeFile(path.join(legacy, "sessions.db-wal"), "original wal");
    const lstat = fs.lstat;
    let injected = false;
    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async (source, dest) => {
        if (dest === path.join(target, "sessions.db")) {
          t.mock.method(fs, "lstat", async (file, ...args) => {
            const state = await lstat(file, ...args);
            if (!injected && String(file).includes(".publish-recovery-") && String(file).endsWith("sessions.db-wal")) {
              injected = true;
              await fs.writeFile(path.join(target, "sessions.db-wal"), "external successor");
            }
            return state;
          });
          throw ioError("ENOSPC");
        }
        await fs.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
      },
    });
    assert.equal(injected, true);
    assert.equal(result.criticalFailures.length, 1);
    assert.equal(await fs.readFile(path.join(target, "sessions.db-wal"), "utf8"), "external successor");
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    assert.equal(await fs.readFile(path.join(legacy, "sessions.db-wal"), "utf8"), "original wal");
  });

  it("verifies restored bytes before deleting recovery originals", async (t) => {
    seedDatabase();
    const original = await fs.readFile(path.join(legacy, "sessions.db"));
    const open = fs.open;
    let injected = false;
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === path.join(legacy, "sessions.db") && args[0] === "wx") {
        const write = handle.write.bind(handle);
        t.mock.method(handle, "write", async (...writeArgs) => {
          const result = await write(...writeArgs);
          if (!injected) { injected = true; await fs.writeFile(file, "external restoration edit"); }
          return result;
        });
      }
      return handle;
    });
    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async () => { throw ioError("ENOSPC"); },
    });
    assert.equal(injected, true);
    assert.equal(result.criticalFailures.length, 1);
    assert.match(result.criticalFailures[0].message, /content changed/);
    const dirs = await retirementDirs();
    assert.deepEqual(await fs.readFile(path.join(legacy, dirs[0], "sessions.db")), original);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
  });
});
