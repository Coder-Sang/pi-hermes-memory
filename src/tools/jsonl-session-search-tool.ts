import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_ROOT } from "../paths.js";
import { searchSessionAnchors, type SessionAnchorRange } from "../store/session-anchor-search.js";

interface SearchResult {
  success: boolean;
  message?: string;
  count?: number;
  output?: string;
  ranges?: SessionAnchorRange[];
}
import { createSharedToolResultRenderer } from "./shared-output-view.js";
import { searchResultView } from "./tool-result-views.js";

/** Search the original Pi JSONL files directly; no indexing or SQLite. */
export function registerJsonlSessionSearchTool(pi: ExtensionAPI, sessionsDir = path.join(AGENT_ROOT, "sessions")): void {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: `Search past Pi session JSONL files and return source line-range anchors. Pass a Markdown request with optional from, to, cwd, limit, and all/any/exclude lists. No SQLite index is used.`,
    promptSnippet: "Search past sessions for source anchors",
    promptGuidelines: ["Use session_search to find previous discussions; read the returned JSONL anchors for full context."],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({ markdown: Type.String({ description: "Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists." }) }),
    async execute(_id, { markdown }) {
      const found = searchSessionAnchors(markdown, { sessionsDir });
      if (!found.success) {
        const details: SearchResult = { success: false, message: found.message ?? "Session search failed." };
        return { content: [{ type: "text" as const, text: details.message! }], details };
      }
      const lines = [`count: ${found.ranges.length}`];
      if (found.message) lines.push(`message: ${found.message}`);
      if (found.ranges.length) {
        lines.push("anchors:");
        for (const range of found.ranges) {
          const reason = range.reason.replace(/\s+/g, " ").trim();
          const suffix = [range.sessionId ? `session_id: ${range.sessionId}` : "", reason.length > 180 ? `${reason.slice(0, 177)}...` : reason].filter(Boolean).join("; ");
          lines.push(`- ${range.path}:${range.startLine}-${range.endLine}${suffix ? ` — ${suffix}` : ""}`);
        }
      }
      const output = lines.join("\n");
      const details: SearchResult = { success: true, count: found.ranges.length, message: found.message, output, ranges: found.ranges };
      return { content: [{ type: "text" as const, text: output }], details };
    },
  });
}
