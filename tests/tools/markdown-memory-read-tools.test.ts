import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerMarkdownMemoryReadTools } from "../../src/tools/markdown-memory-read-tools.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { createMemoryInitializer } from "../../src/memory-initialization.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

let root: string;
let globalDir: string;
let projectDir: string;
let store: MemoryStore;
let project: MemoryStore;
let tools: Map<string, any>;

function config(memoryDir: string): MemoryConfig {
  return { memoryDir, memoryMode: "legacy-inject", memoryCharLimit: 50000, userCharLimit: 50000, failureInjectionEnabled: false } as MemoryConfig;
}

function register(currentProject: MemoryStore | null = project, lifecycle?: ReturnType<typeof createMemoryInitializer>) {
  const captured = new Map<string, any>();
  registerMarkdownMemoryReadTools({ registerTool(tool: any) { captured.set(tool.name, tool); } } as any,
    store, () => currentProject, lifecycle);
  return captured;
}

const read = (input: unknown, signal?: AbortSignal) => tools.get("memory_read").execute("read", input, signal);
const search = (input: unknown, signal?: AbortSignal) => tools.get("memory_search").execute("search", input, signal);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "markdown-read-"));
  globalDir = path.join(root, "global");
  projectDir = path.join(root, "project");
  await fs.mkdir(globalDir);
  await fs.mkdir(projectDir);
  store = new MemoryStore(config(globalDir));
  project = new MemoryStore(config(projectDir));
  tools = register();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("Markdown memory read tools", () => {
  it("registers read and search in a stable order with shared result rendering", async () => {
    assert.deepEqual([...tools.keys()], ["memory_read", "memory_search"]);
    for (const tool of tools.values()) assert.equal(typeof tool.renderResult, "function");
    const definitions = () => [...tools.values()].map(({ name, description, parameters, promptSnippet, promptGuidelines }) => ({ name, description, parameters, promptSnippet, promptGuidelines }));
    const initial = JSON.stringify(definitions());
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), "a new arbitrary fact");
    tools = register();
    assert.equal(initial, JSON.stringify(definitions()));
  });

  it("reads all four targets without exposing internal metadata", async () => {
    const metadata = " <!-- created=2020-01-01, last=2020-01-01, project64=ZGVtbw -->";
    for (const [target, directory, filename] of [
      ["memory", globalDir, "MEMORY.md"], ["user", globalDir, "USER.md"],
      ["project", projectDir, "MEMORY.md"], ["failure", globalDir, "failures.md"],
    ]) {
      await fs.writeFile(path.join(directory, filename), `${target} fact${metadata}`);
      const result = await read({ target });
      assert.equal(result.details.content, `${target} fact`);
      assert.equal(result.details.target, target);
      assert.equal(result.details.nextOffset, null);
      assert.match(result.details.revision, /^[a-f0-9]{64}$/);
      assert.equal(result.isError, undefined);
    }
  });

  it("preserves delimiters, Unicode code points and search/read locations", async () => {
    const entries = ["first 😀", "中文 e\u0301 𝌆", "last"];
    const content = entries.join(ENTRY_DELIMITER);
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), content);
    let offset = 0;
    let revision: string | undefined;
    let collected = "";
    do {
      const result = await read({ target: "memory", offset, limit: 3, ...(revision ? { revision } : {}) });
      assert.equal(result.details.success, true);
      collected += result.details.content;
      revision = result.details.revision;
      assert.equal(result.details.totalChars, Array.from(content).length);
      if (result.details.nextOffset === null) break;
      offset = result.details.nextOffset;
    } while (true);
    assert.equal(collected, content);
    const hit = (await search({ query: "中文" })).details.results[0];
    assert.equal(hit.offset, Array.from(entries[0] + ENTRY_DELIMITER).length);
    assert.equal((await read({ target: hit.target, offset: hit.offset, limit: hit.length, revision: hit.revision })).details.content, entries[1]);
  });

  it("bounds default/max pages and excerpts for long entries", async () => {
    const content = "词😀".repeat(10000);
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), content);
    assert.equal(Array.from((await read({ target: "memory" })).details.content).length, 8000);
    assert.equal(Array.from((await read({ target: "memory", limit: 16000 })).details.content).length, 16000);
    const hit = (await search({ query: "词" })).details.results[0];
    assert.equal(Array.from(hit.excerpt).length, 512);
    assert.equal(hit.length, 20000);
  });

  it("requires revisions for continuations and rejects mixed versions", async () => {
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), "old text");
    const first = await read({ target: "memory", limit: 3 });
    assert.equal((await read({ target: "memory", offset: 3 })).details.error, "invalid_arguments");
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), "new text");
    const stale = await read({ target: "memory", offset: 3, revision: first.details.revision });
    assert.equal(stale.isError, true);
    assert.equal(stale.details.error, "memory_changed");
    assert.equal(stale.details.content, undefined);
    assert.equal((await read({ target: "memory" })).details.content, "new text");
  });

  it("returns empty pages for missing files and offsets at/past the end", async () => {
    const empty = await read({ target: "user" });
    assert.equal(empty.details.content, "");
    assert.equal(empty.details.totalChars, 0);
    await fs.writeFile(path.join(globalDir, "USER.md"), "x");
    const first = await read({ target: "user" });
    for (const offset of [1, 100]) {
      const result = await read({ target: "user", offset, revision: first.details.revision });
      assert.equal(result.details.content, "");
      assert.equal(result.details.nextOffset, null);
    }
  });

  it("observes external writes without refreshing a legacy injection snapshot", async () => {
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), "original");
    await store.loadFromDisk();
    const before = store.formatForSystemPrompt();
    const other = new MemoryStore(config(globalDir));
    await other.loadFromDisk();
    await other.add("memory", "external update");
    assert.match((await read({ target: "memory" })).details.content, /external update/);
    assert.equal((await search({ query: "external update" })).details.count, 1);
    assert.equal(store.formatForSystemPrompt(), before);
  });

  it("returns explicit errors for unsupported arguments and invalid ranges", async () => {
    for (const input of [null, [], {}, { target: "all" }, { target: "../secret" },
      { target: "memory", offset: -1 }, { target: "memory", offset: 1.5 },
      { target: "memory", limit: 0 }, { target: "memory", limit: 16001 },
      { target: "memory", revision: "bad" }, { target: "memory", path: "/elsewhere" },
      { target: "project", project: "other" }]) {
      const result = await read(input);
      assert.equal(result.isError, true, JSON.stringify(input));
      assert.equal(result.details.error, "invalid_arguments");
    }
    for (const input of [{ query: " " }, { query: "\u3000" }, { query: 1 }, { query: "x", category: "other" },
      { query: "x", target: "all" }, { query: "x", limit: 21 }, { query: "x", limit: 1.1 },
      { query: "x", project: "other" }]) {
      const result = await search(input);
      assert.equal(result.isError, true, JSON.stringify(input));
      assert.equal(result.details.error, "invalid_arguments");
    }
  });

  it("does not reveal filesystem errors or fall back to injection", async () => {
    await fs.mkdir(path.join(globalDir, "MEMORY.md"));
    const result = await read({ target: "memory" });
    assert.equal(result.details.error, "memory_read_failed");
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, new RegExp(root));
  });

  it("skips an absent project for broad searches and errors for explicit project access", async () => {
    tools = register(null);
    assert.equal((await read({ target: "project" })).details.error, "project_unavailable");
    assert.equal((await search({ target: "project", query: "x" })).details.error, "project_unavailable");
    assert.equal((await search({ query: "x" })).details.count, 0);
  });

  it("supports cancellation before disk access", async () => {
    const result = await read({ target: "memory" }, AbortSignal.abort());
    assert.equal(result.details.error, "memory_cancelled");
    assert.equal(result.isError, true);
    assert.equal((await fs.readdir(globalDir)).length, 0);
  });

  it("validates arguments before initialization or filesystem access", async () => {
    let loads = 0;
    const init = createMemoryInitializer(async () => { loads++; throw new Error("should not load"); });
    tools = register(project, init);
    const result = await tools.get("memory_read").execute("invalid", { target: "memory", offset: 2 }, undefined, undefined, { cwd: root });
    assert.equal(result.details.error, "invalid_arguments");
    assert.equal(loads, 0);
    await init.close();
  });

  it("tracks initialization, cancellation and shutdown without unguarded reads", async () => {
    const gate = Promise.withResolvers<void>();
    let loads = 0;
    const init = createMemoryInitializer(async () => { loads++; await gate.promise; });
    tools = register(project, init);
    const tool = tools.get("memory_read");
    const controller = new AbortController();
    const waiting = tool.execute("one", { target: "memory" }, controller.signal, undefined, { cwd: root });
    await new Promise(setImmediate);
    let closed = false;
    const closing = init.close().then(() => { closed = true; });
    controller.abort();
    assert.equal((await waiting).details.error, "memory_cancelled");
    assert.equal(closed, false);
    gate.resolve();
    await closing;
    assert.equal(loads, 1);
    assert.equal((await tool.execute("two", { target: "memory" }, undefined, undefined, { cwd: root })).isError, true);
  });
});

describe("literal Markdown search", () => {
  it("matches Chinese, case variants and Unicode width with AND semantics", async () => {
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), ["使用 ＰＮＰＭ 构建项目", "pnpm only", "中文检索约定"].join(ENTRY_DELIMITER));
    assert.equal((await search({ query: "pnpm 构建" })).details.count, 1);
    assert.equal((await search({ query: "中文检索" })).details.count, 1);
    assert.equal((await search({ query: "PNPM" })).details.count, 2);
    assert.equal((await search({ query: "pnpm absent" })).details.count, 0);
    assert.equal((await search({ query: "[.*]" })).details.count, 0);
    assert.equal((await search({ query: "pnpm OR absent" })).details.count, 0);
  });

  it("preserves scope/file order and supports target/category filters", async () => {
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), ["term global one", "term global two"].join(ENTRY_DELIMITER));
    await fs.writeFile(path.join(globalDir, "USER.md"), "term user");
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), "term project");
    await fs.writeFile(path.join(globalDir, "failures.md"), "[correction] term old <!-- created=2000-01-01, last=2000-01-01 -->");
    const results = (await search({ query: "term" })).details.results;
    assert.deepEqual(results.map((hit: any) => hit.target), ["memory", "memory", "user", "project", "failure"]);
    assert.match(results[1].excerpt, /global two/);
    assert.equal((await search({ query: "term", target: "project" })).details.count, 1);
    const categorized = await search({ query: "term", category: "correction" });
    assert.equal(categorized.details.count, 1);
    assert.equal(categorized.details.results[0].target, "failure");
    assert.doesNotMatch(categorized.details.results[0].excerpt, /created=/);
  });

  it("caps result counts and never creates or modifies a database", async () => {
    await fs.writeFile(path.join(globalDir, "MEMORY.md"), Array.from({ length: 25 }, (_, i) => `term ${i}`).join(ENTRY_DELIMITER));
    const database = path.join(globalDir, "sessions.db");
    await fs.writeFile(database, "untouched legacy database");
    assert.equal((await search({ query: "term" })).details.count, 10);
    assert.equal((await search({ query: "term", limit: 20 })).details.count, 20);
    await read({ target: "memory" });
    assert.equal(await fs.readFile(database, "utf8"), "untouched legacy database");
    assert.deepEqual((await fs.readdir(projectDir)), []);
  });
});
