import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { StandingInstructions } from "./store/standing-instructions.js";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText">;

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";

  switch (style) {
    case "compact":
      return MEMORY_POLICY_PROMPT_COMPACT;
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT;
    case "none":
      return "";
    case "full":
    default:
      return MEMORY_POLICY_PROMPT;
  }
}

/**
 * Pinned user instructions remain present in every mode, including policy style
 * none. Ordinary memories are retrieved through tools in policy-only mode.
 */
export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
  standing: StandingInstructions | null = null,
): Promise<string> {
  const standingBlock = standing?.formatForSystemPrompt() ?? "";

  if (config.memoryMode === "policy-only") {
    return [resolveMemoryPolicyPrompt(config), standingBlock].filter(Boolean).join("\n\n");
  }

  const memoryBlock = store.formatForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);
  if (standingBlock) parts.push(standingBlock);

  return parts.join("\n\n");
}
