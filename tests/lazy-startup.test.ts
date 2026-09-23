import assert from "node:assert/strict";
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
  it("does not register SQLite search or index commands", async () => {
    register();
    assert.deepEqual(Object.keys(tools).sort(), ["memory_add", "memory_remove", "memory_replace", "session_search", "skill_manage"]);
    assert.equal(commands["memory-index-sessions"], undefined);
    assert.equal(commands["memory-sync-markdown"], undefined);
    await emit("session_start");
    const before = await emit("before_agent_start", { systemPrompt: "base" });
    assert.match(before.systemPrompt, /durable global fact/);
    assert.doesNotMatch(before.systemPrompt, /memory_search/);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("uses a frozen Markdown prompt snapshot and persists writes without a DB", async () => {
    register();
    await emit("session_start");
    const before = await emit("before_agent_start", { systemPrompt: "base" });
    const result = await tools.memory_add.execute("id", { target: "memory", content: "new durable fact" }, undefined, undefined, ctx);
    assert.equal(result.details.success, true);
    const after = await emit("before_agent_start", { systemPrompt: "base" });
    assert.equal(before.systemPrompt, after.systemPrompt);
    assert.match(await fs.readFile(path.join(globalDir, "MEMORY.md"), "utf8"), /new durable fact/);
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
    assert.match(await fs.readFile(path.join(globalDir, "USER.md"), "utf8"), /legacy durable preference/);
    assert.equal(await fs.readFile(path.join(legacy, "sessions.db"), "utf8"), "preserve old database");
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });
});
