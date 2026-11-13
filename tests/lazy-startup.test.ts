import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, afterEach, describe, it } from "node:test";

// Load the extension with a disposable agent root, never the user's memory.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-markdown-startup-"));
const previousRoot = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { default: registerExtension } = await import("../src/index.js");
const globalDir = path.join(root, "pi-hermes-memory");
const cwd = path.join(root, "workspace");
const projectDir = path.join(root, "projects-memory", "workspace");
let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let tools: Record<string, any>;
let commands: Record<string, any>;
let ctx: any;

function register() {
  registerExtension({
    on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand(name: string, options: any) { commands[name] = options; },
  } as any);
}

async function emit(event: string, data: any = {}) {
  let result: any;
  for (const handler of handlers[event] ?? []) result = (await handler(data, ctx)) ?? result;
  return result;
}

beforeEach(async () => {
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(globalDir, "MEMORY.md"), "durable global fact");
  await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
    memoryMode: "policy-only", lazyInitialization: true,
    sessionSearch: { variant: "legacy" },
    reviewEnabled: false, correctionDetection: false,
    flushOnCompact: false, flushOnShutdown: false,
  }));
  handlers = {}; tools = {}; commands = {};
  ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => [], getSessionFile: () => undefined }, ui: { notify: () => {} } };
});

afterEach(async () => {
  await emit("session_shutdown", { reason: "quit" });
  for (const name of await fs.readdir(root)) await fs.rm(path.join(root, name), { recursive: true, force: true });
});

after(async () => {
  if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe("Markdown-only startup lifecycle", () => {
  it("registers read/search tools without SQLite index commands or memory injection", async () => {
    register();
    assert.deepEqual(Object.keys(tools).sort(), ["memory_add", "memory_read", "memory_remove", "memory_replace", "memory_search", "session_search", "skill_manage"]);
    assert.equal(commands["memory-index-sessions"], undefined);
    assert.equal(commands["memory-sync-markdown"], undefined);
    await emit("session_start");
    const before = await emit("before_agent_start", { systemPrompt: "base" });
    assert.doesNotMatch(before.systemPrompt, /durable global fact/);
    assert.match(before.systemPrompt, /memory_search/);
    assert.match(before.systemPrompt, /memory_read/);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("keeps policy stable while persisting and retrieving writes without a DB", async () => {
    register();
    await emit("session_start");
    const before = await emit("before_agent_start", { systemPrompt: "base" });
    const result = await tools.memory_add.execute("id", { target: "memory", content: "new durable fact" }, undefined, undefined, ctx);
    assert.equal(result.details.success, true);
    const after = await emit("before_agent_start", { systemPrompt: "base" });
    assert.equal(before.systemPrompt, after.systemPrompt);
    assert.match(await fs.readFile(path.join(globalDir, "MEMORY.md"), "utf8"), /new durable fact/);
    const read = await tools.memory_read.execute("read", { target: "memory" }, undefined, undefined, ctx);
    assert.match(read.details.content, /new durable fact/);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("searches old JSONL sessions even when legacy SQLite search was configured", async () => {
    const sessions = path.join(root, "sessions", "workspace");
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "history.jsonl"), [
      { type: "session", id: "history", timestamp: "2026-05-10T00:00:00Z", cwd },
      { type: "message", id: "m1", timestamp: "2026-05-10T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "historical deployment decision" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    register();
    await emit("session_start");
    const result = await tools.session_search.execute("id", { markdown: "all:\n- historical" }, undefined, undefined, ctx);
    assert.equal(result.details.count, 1);
    assert.match(result.content[0].text, /history\.jsonl:/);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("copies legacy Markdown before loading without touching the old SQLite database", async () => {
    const legacy = path.join(root, "memory");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "USER.md"), "legacy durable preference");
    await fs.writeFile(path.join(legacy, "sessions.db"), "preserve old database");
    register();
    await emit("session_start");
    await tools.memory_read.execute("read", { target: "user" }, undefined, undefined, ctx);
    assert.match(await fs.readFile(path.join(globalDir, "USER.md"), "utf8"), /legacy durable preference/);
    assert.equal(await fs.readFile(path.join(legacy, "sessions.db"), "utf8"), "preserve old database");
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("keeps system and tool definitions stable across every memory mutation and restart", async () => {
    const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const definitions = () => Object.values(tools).map(({ name, description, parameters, promptSnippet, promptGuidelines }) => ({ name, description, parameters, promptSnippet, promptGuidelines }));
    register();
    await emit("session_start");
    const system = (await emit("before_agent_start", { systemPrompt: "base" })).systemPrompt;
    const toolHash = fingerprint(definitions());
    for (const target of ["memory", "user", "project", "failure"]) {
      const added = await tools.memory_add.execute("add", { target, content: `durable ${target} audit item` }, undefined, undefined, ctx);
      assert.equal(added.details.success, true);
      const found = await tools.memory_search.execute("search", { target, query: "audit item" }, undefined, undefined, ctx);
      assert.equal(found.details.count, 1);
      const hit = found.details.results[0];
      const read = await tools.memory_read.execute("read", { target, offset: hit.offset, limit: hit.length, revision: hit.revision }, undefined, undefined, ctx);
      assert.match(read.details.content, /audit item/);
      const replaced = await tools.memory_replace.execute("replace", { target, old_text: read.details.content, content: `changed ${target} audit item` }, undefined, undefined, ctx);
      assert.equal(replaced.details.success, true);
      const removed = await tools.memory_remove.execute("remove", { target, old_text: `changed ${target} audit item` }, undefined, undefined, ctx);
      assert.equal(removed.details.success, true);
      assert.equal((await emit("before_agent_start", { systemPrompt: "base" })).systemPrompt, system);
      assert.equal(fingerprint(definitions()), toolHash);
    }
    await fs.writeFile(path.join(globalDir, "USER.md"), "externally changed user preference");
    assert.match((await tools.memory_read.execute("read", { target: "user" }, undefined, undefined, ctx)).details.content, /externally changed/);
    await emit("session_shutdown", { reason: "quit" });
    handlers = {}; tools = {}; commands = {};
    register();
    await emit("session_start");
    assert.equal((await emit("before_agent_start", { systemPrompt: "base" })).systemPrompt, system);
    assert.equal(fingerprint(definitions()), toolHash);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("uses policy-only by default and honors explicit legacy-inject", async () => {
    for (const mode of [undefined, "legacy-inject"]) {
      await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
        ...(mode ? { memoryMode: mode } : {}), lazyInitialization: true,
        reviewEnabled: false, correctionDetection: false, flushOnCompact: false, flushOnShutdown: false,
      }));
      handlers = {}; tools = {}; commands = {};
      register();
      await emit("session_start");
      const system = (await emit("before_agent_start", { systemPrompt: "base" })).systemPrompt;
      assert.equal(system.includes("durable global fact"), mode === "legacy-inject");
      assert.equal(system.includes("<memory-policy>"), mode !== "legacy-inject");
      await emit("session_shutdown", { reason: "quit" });
    }
  });

  it("loads pinned directives and skills while deferring ordinary memory initialization", async () => {
    const legacy = path.join(root, "memory");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "USER.md"), "deferred preference");
    await fs.writeFile(path.join(globalDir, "STANDING.md"), "Always keep the user's source files intact.\n");
    register();
    await emit("session_start");
    assert.equal(existsSync(path.join(globalDir, "USER.md")), false);
    const system = (await emit("before_agent_start", { systemPrompt: "base" })).systemPrompt;
    assert.match(system, /Always keep the user's source files intact/);
    assert.equal(existsSync(path.join(globalDir, "USER.md")), false);
    const resources = await emit("resources_discover", { cwd });
    assert.ok(resources.skillPaths.length > 0);
    const read = await tools.memory_read.execute("read", { target: "user" }, undefined, undefined, ctx);
    assert.match(read.details.content, /deferred preference/);
  });

  it("resolves each read to the supplied current project instead of a stale binding", async () => {
    const otherCwd = path.join(root, "other-project");
    const otherMemory = path.join(root, "projects-memory", "other-project");
    await fs.mkdir(otherCwd);
    await fs.mkdir(otherMemory);
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), "first project fact");
    await fs.writeFile(path.join(otherMemory, "MEMORY.md"), "other project fact");
    register();
    await emit("session_start");
    const [first, other] = await Promise.all([
      tools.memory_read.execute("first", { target: "project" }, undefined, undefined, ctx),
      tools.memory_read.execute("other", { target: "project" }, undefined, undefined, { ...ctx, cwd: otherCwd }),
    ]);
    assert.equal(first.details.content, "first project fact");
    assert.equal(other.details.content, "other project fact");
  });
  async function hostConfig(extra: Record<string, unknown>) {
    const file = path.join(root, "hermes-memory-config.json");
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), ...extra }));
  }

  it("honors the exact host leaf for reads, writes, skills and restart despite a different cwd", async () => {
    const leaf = path.join(root, "host-storage", "opaque-project");
    const global = path.join(root, "host-global");
    await fs.mkdir(leaf, { recursive: true });
    await fs.mkdir(global, { recursive: true });
    await fs.writeFile(path.join(leaf, "MEMORY.md"), "host project fact");
    await fs.writeFile(path.join(global, "MEMORY.md"), "host global fact");
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), "wrong cwd fact");
    await hostConfig({ memoryDir: global, projectMemoryDir: leaf, sessionSearchEnabled: false,
      memoryPolicyStyle: "custom", memoryPolicyCustomText: "<memory-policy>custom lookup policy</memory-policy>" });
    register();
    await emit("session_start");
    assert.equal(tools.session_search, undefined);
    assert.equal(commands["memory-switch-project"], undefined);
    const policy = (await emit("before_agent_start", { systemPrompt: "base" })).systemPrompt;
    assert.match(policy, /custom lookup policy/);
    assert.doesNotMatch(policy, /host project fact|host global fact/);
    const resources = await emit("resources_discover", { cwd });
    assert.ok(resources.skillPaths.includes(path.join(leaf, "skills")));
    assert.ok(!resources.skillPaths.includes(path.join(projectDir, "skills")));
    for (let restart = 0; restart < 2; restart++) {
      const read = await tools.memory_read.execute("r", { target: "project" }, undefined, undefined, ctx);
      assert.match(read.details.content, /host project fact/);
      assert.doesNotMatch(read.details.content, /wrong cwd fact/);
      const found = await tools.memory_search.execute("s", { target: "project", query: "host project" }, undefined, undefined, ctx);
      assert.equal(found.details.count, 1);
      const globalRead = await tools.memory_read.execute("r", { target: "memory" }, undefined, undefined, ctx);
      assert.match(globalRead.details.content, /host global fact/);
      if (restart === 0) {
        const add = await tools.memory_add.execute("a", { target: "project", content: "host persisted addition" }, undefined, undefined, ctx);
        assert.equal(add.details.success, true);
        assert.match(await fs.readFile(path.join(leaf, "MEMORY.md"), "utf8"), /host persisted addition/);
        await emit("session_shutdown", { reason: "quit" });
        handlers = {}; tools = {}; commands = {};
        register(); await emit("session_start");
      } else assert.match(read.details.content, /host persisted addition/);
    }
    assert.equal(existsSync(path.join(global, "sessions.db")), false);
    assert.equal(existsSync(path.join(leaf, "opaque-project")), false);
  });

  it("never guesses a disabled/missing host project and keeps global retrieval available", async () => {
    await fs.rm(path.join(root, "projects-memory"), { recursive: true });
    const forbiddenLeaf = path.join(root, "must-not-create");
    await hostConfig({ projectMemoryEnabled: false, projectMemoryDir: forbiddenLeaf, sessionSearchEnabled: false });
    register(); await emit("session_start");
    assert.equal(tools.session_search, undefined);
    const resources = await emit("resources_discover", { cwd });
    assert.ok(!resources.skillPaths.some((p: string) => p.includes("must-not-create") || p.includes("projects-memory")));
    const read = await tools.memory_read.execute("r", { target: "project" }, undefined, undefined, ctx);
    assert.equal(read.details.error, "project_unavailable");
    const add = await tools.memory_add.execute("a", { target: "project", content: "must not persist" }, undefined, undefined, ctx);
    assert.equal(add.details.success, false);
    const found = await tools.memory_search.execute("s", { query: "durable global" }, undefined, undefined, ctx);
    assert.equal(found.details.count, 1);
    assert.equal(existsSync(forbiddenLeaf), false);
    assert.equal(existsSync(path.join(root, "projects-memory")), false);
  });

});
