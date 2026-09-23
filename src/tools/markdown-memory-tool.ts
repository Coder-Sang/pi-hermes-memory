import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
import { MEMORY_TOOL_DESCRIPTION } from "../constants.js";
import { resolveProjectStore, type ProjectStoreRef } from "../project-context.js";
import { normalizeMemoryLookupText } from "../store/memory-lookup.js";
import type { MemoryCategory, MemoryResult } from "../types.js";
import { createSharedToolResultRenderer } from "./shared-output-view.js";
import { memoryResultView } from "./tool-result-views.js";

type Target = "memory" | "user" | "failure" | "project";
type Action = "add" | "replace" | "remove";
type Params = { target: Target; content?: string; old_text?: string; category?: MemoryCategory; failure_reason?: string };

function matchingTargets(text: string, store: MemoryStore, projectStore: MemoryStore | null): Target[] {
  const lookup = normalizeMemoryLookupText(text);
  if (!lookup) return [];
  const targets: Target[] = [];
  if (store.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push("memory");
  if (store.getUserEntries().some((entry) => entry.includes(lookup))) targets.push("user");
  if (store.getAllFailureEntries().some((entry) => entry.includes(lookup))) targets.push("failure");
  if (projectStore?.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push("project");
  return targets;
}

function formatResult(result: MemoryResult): string {
  const rotated = result.evicted_entries ?? [];
  if (!result.success || rotated.length === 0) return JSON.stringify(result);
  return [
    result.message ?? "Memory updated.", "", "Rotated active memory entries:", "",
    ...rotated.flatMap((entry, index) => [`${index + 1}. ${entry}`, ""]),
    "If one of these entries should stay active, add it again.",
    result.usage ? `Usage: ${result.usage}` : "",
  ].join("\n").trim();
}

/** The runtime memory tools write Markdown only; no SQLite mirror is opened. */
export function registerMarkdownMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  bindProjectFromCwd?: (cwd?: string) => void | Promise<void>,
): (candidate: MemoryStore | null) => void {
  pi.on("tool_result", (event) => {
    if (!event.toolName.startsWith("memory_")) return;
    if ((event.details as { success?: unknown } | undefined)?.success === false) return { isError: true };
  });

  const executeAction = async (action: Action, params: Params, signal?: AbortSignal) => {
    const currentProject = resolveProjectStore(projectStore);
    const currentStore = params.target === "project" ? currentProject : store;
    if (!currentStore) {
      const result = { success: false, error: "Project memory is not available (no project detected)." };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    }
    const target = params.target === "project" ? "memory" : params.target;
    let result: MemoryResult;
    switch (action) {
      case "add":
        if (!params.content) throw new Error("Content is required for 'add' action.");
        result = target === "failure"
          ? await currentStore.addFailure(params.content, { category: params.category ?? "failure", failureReason: params.failure_reason, signal })
          : await currentStore.add(target, params.content, signal);
        break;
      case "replace":
        if (!params.old_text || !params.content) throw new Error("old_text and content are required for 'replace'.");
        result = await currentStore.replace(target, params.old_text, params.content, signal);
        break;
      case "remove":
        if (!params.old_text) throw new Error("old_text is required for 'remove'.");
        result = await currentStore.remove(target, params.old_text, signal);
        break;
    }
    if (!result.success && result.error?.startsWith("No entry matched") && params.old_text) {
      const alternatives = matchingTargets(params.old_text, store, currentProject).filter((candidate) => candidate !== params.target);
      if (alternatives.length) {
        result = { ...result,
          error: `No match in target "${params.target}"; matching entry found in ${alternatives.length === 1 ? "target" : "targets"} ${alternatives.map((candidate) => `"${candidate}"`).join(", ")}. Retry with the displayed target.`,
          matching_targets: alternatives,
        };
      }
    }
    if (params.target === "project" && result.success) result = { ...result, target: "project" };
    return { content: [{ type: "text" as const, text: formatResult(result) }], details: result };
  };

  const target = StringEnum(["memory", "user", "project", "failure"] as const, {
    description: "Memory scope. Use failure for failures, corrections, insights, and tool quirks.",
  });
  const register = (action: Action, name: string, label: string, parameters: TSchema) => {
    pi.registerTool({
      name, label,
      description: `${MEMORY_TOOL_DESCRIPTION}\n\n${label} persists entries in Markdown.`,
      promptSnippet: `${label}: persistent memory that survives across sessions`,
      promptGuidelines: [
        "Save durable preferences, corrections, and project facts proactively.",
        "Do not save temporary task state or session progress.",
      ],
      renderResult: createSharedToolResultRenderer(memoryResultView),
      parameters,
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (ctx?.cwd && bindProjectFromCwd) await bindProjectFromCwd(ctx.cwd);
        return executeAction(action, params as Params, signal);
      },
    });
  };
  register("add", "memory_add", "Memory Add", Type.Object({
    target, content: Type.String(),
    category: Type.Optional(StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const)),
    failure_reason: Type.Optional(Type.String()),
  }));
  register("replace", "memory_replace", "Memory Replace", Type.Object({ target, old_text: Type.String(), content: Type.String() }));
  register("remove", "memory_remove", "Memory Remove", Type.Object({ target, old_text: Type.String() }));
  return () => {};
}
