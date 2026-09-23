import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerMarkdownMemoryTool } from "../../src/tools/markdown-memory-tool.js";
import { registerJsonlSessionSearchTool } from "../../src/tools/jsonl-session-search-tool.js";
import { migrateMarkdownMemoryFiles } from "../../src/markdown-root-migration.js";
import { MemoryStore } from "../../src/store/memory-store.js";

function register() {
  const tools = new Map<string, any>();
  const pi = { on: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as any;
  return { pi, tools };
}

describe("SQLite-free runtime", () => {
  it("registers Markdown memory writes, not memory_search", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-only-"));
    try {
      const store = new MemoryStore({ memoryDir: dir, memoryMode: "legacy-inject", memoryCharLimit: 5000, userCharLimit: 5000 } as any);
      await store.loadFromDisk();
      const { pi, tools } = register();
      registerMarkdownMemoryTool(pi, store, null);
      assert.deepEqual([...tools.keys()], ["memory_add", "memory_replace", "memory_remove"]);
      const added = await tools.get("memory_add").execute("one", { target: "memory", content: "prefers pnpm" });
      assert.equal(added.details.success, true);
      assert.match(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"), /prefers pnpm/);
      // Prompt snapshots are frozen until the next session load.
      await store.loadFromDisk();
      assert.match(store.formatForSystemPrompt(), /prefers pnpm/);
      const replaced = await tools.get("memory_replace").execute("two", { target: "memory", old_text: "prefers pnpm", content: "prefers yarn" });
      assert.equal(replaced.details.success, true);
      const removed = await tools.get("memory_remove").execute("three", { target: "memory", old_text: "prefers yarn" });
      assert.equal(removed.details.success, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches original JSONL files without building an index", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-jsonl-"));
    try {
      fs.writeFileSync(path.join(dir, "test.jsonl"), [
        JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-05-10T00:00:00Z", cwd: "/tmp/repo" }),
        JSON.stringify({ type: "message", id: "m1", timestamp: "2026-05-10T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "alpha beta gamma" }] } }),
      ].join("\n") + "\n");
      const { pi, tools } = register();
      registerJsonlSessionSearchTool(pi, dir);
      assert.deepEqual([...tools.keys()], ["session_search"]);
      const result = await tools.get("session_search").execute("one", { markdown: "all:\n- alpha" });
      assert.equal(result.details.success, true);
      assert.match(result.content[0].text, /test\.jsonl:/);
      assert.equal(fs.existsSync(path.join(dir, "sessions.db")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy Markdown without overwriting newer files or opening SQLite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-migration-"));
    try {
      const old = path.join(dir, "memory");
      const next = path.join(dir, "pi-hermes-memory");
      fs.mkdirSync(old);
      fs.mkdirSync(next);
      fs.writeFileSync(path.join(old, "MEMORY.md"), "old");
      fs.writeFileSync(path.join(old, "USER.md"), "profile");
      fs.writeFileSync(path.join(next, "MEMORY.md"), "new");
      await migrateMarkdownMemoryFiles(old, next);
      assert.equal(fs.readFileSync(path.join(next, "MEMORY.md"), "utf8"), "new");
      assert.equal(fs.readFileSync(path.join(next, "USER.md"), "utf8"), "profile");
      assert.equal(fs.existsSync(path.join(next, "sessions.db")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
