import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { registerMarkdownMemoryTool } from "../../src/tools/markdown-memory-tool.js";
import { registerJsonlSessionSearchTool } from "../../src/tools/jsonl-session-search-tool.js";
import { registerSkillTool } from "../../src/tools/skill-tool.js";

function capture(register: (pi: any) => void): any {
  let definition: any;
  register({ on() {}, registerTool(value: any) { definition = value; } });
  return definition;
}

describe("tool result renderer wiring", () => {
  it("registers renderResult on Markdown memory tools", () => {
    const memory = capture((pi) => registerMarkdownMemoryTool(pi, {} as any, null));
    assert.equal(typeof memory.renderResult, "function");
  });

  it("registers renderResult on JSONL session_search", () => {
    const search = capture((pi) => registerJsonlSessionSearchTool(pi, "/path-independent-sessions"));
    assert.equal(typeof search.renderResult, "function");
  });

  it("registers renderResult on skill_manage", () => {
    const skill = capture((pi) => registerSkillTool(pi, {} as any));
    assert.equal(typeof skill.renderResult, "function");
  });
});
