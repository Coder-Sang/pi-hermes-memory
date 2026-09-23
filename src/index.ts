/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. /memory-insights — shows what's stored
 * 9. /memory-skills — lists procedural skills
 * 10. /memory-consolidate — manual consolidation trigger
 * 11. /memory-interview — onboarding interview to pre-fill user profile
 * 12. /memory-switch-project — list project memories
 * 13. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 14. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { registerMarkdownMemoryTool } from "./tools/markdown-memory-tool.js";
import { registerJsonlSessionSearchTool } from "./tools/jsonl-session-search-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { registerPreviewContextCommand } from "./handlers/preview-context.js";
import { registerStandingPinCommand } from "./handlers/standing-pin.js";
import { StandingInstructions } from "./store/standing-instructions.js";
import { STANDING_FILE } from "./constants.js";
import { loadConfig } from "./config.js";
import { shouldWarnAutoConsolidationFailure } from "./auto-consolidation-warning.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext } from "./prompt-context.js";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration.js";
import { AGENT_ROOT } from "./paths.js";
import { migrateMarkdownMemoryFiles } from "./markdown-root-migration.js";
import { measureLifecycle } from "./lifecycle-timing.js";
import { createMemoryInitializer, withMemoryInitialization, type EnsureMemoryReady } from "./memory-initialization.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  // Pi auto-discovers its own `~/.pi/agent/skills/`, but this extension keeps
  // its generated skills in a directory of its own so users can audit, wipe, or
  // ignore them without touching skills they installed themselves (#126). Both
  // of ours must therefore be contributed here.
  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);
  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });
}

export default function (pi: ExtensionAPI) {
  const loadedConfig = loadConfig();
  // A policy-only prompt without memory_search would hide all stored facts.
  const config = { ...loadedConfig, memoryMode: "legacy-inject" as const };

  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  const defaultGlobalDir = path.join(agentRoot, "pi-hermes-memory");

  const configuredMemoryDir = config.memoryDir?.trim();
  const pointsToLegacyMemoryDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    : false;

  const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
    ? defaultGlobalDir
    : configuredMemoryDir;

  const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
  let persistenceInitialized = false;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  // Factory may run with no session (Pi public contract). Do not snapshot
  // project identity from process.cwd() here — bind from session_start ctx.cwd
  // and from tool execute ctx.cwd.
  let projectName = "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: null,
    projectName: null,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  // Markdown and skill files are the only runtime persistence stores.

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Keep project memory available for users upgrading from the old
  // ~/.pi/agent/<project>/ layout. This is non-destructive: legacy folders
  // remain in place while entries are copied/merged into projects-memory/.
  migrateLegacyProjectMemoryDirs(agentRoot, config.projectsMemoryDir);
  // Project-scoped store: ~/.pi/agent/<projectsMemoryDir>/<project_name>/
  // Bound from session/tool ctx.cwd, never from factory process.cwd().
  const createProjectStore = (projectInfo: ReturnType<typeof detectProject>): MemoryStore | null => {
    if (!projectInfo.memoryDir) return null;
    return new MemoryStore({
      ...config,
      memoryCharLimit: config.projectCharLimit,
      memoryDir: projectInfo.memoryDir,
    });
  };
  let projectMemoryDir: string | null = null;
  let projectStore: MemoryStore | null = null;
  let projectLoad: Promise<void> | undefined;
  const projectStoreRef = () => projectStore;
  const projectNameRef = () => projectName;
  let configureProjectStore: (candidate: MemoryStore | null) => void = () => {};
  const bindProjectFromCwd = async (cwd?: string): Promise<void> => {
    if (!cwd) return;
    const nextProject = detectProject(config.projectsMemoryDir, cwd);
    const nextProjectMemoryDir = nextProject.memoryDir ?? null;
    if (nextProjectMemoryDir !== projectMemoryDir) {
      projectMemoryDir = nextProjectMemoryDir;
      projectStore = createProjectStore(nextProject);
      configureProjectStore(projectStore);
      projectLoad = projectStore?.loadFromDisk().catch((error) => {
        projectMemoryDir = null;
        projectStore = null;
        projectName = "";
        projectLoad = undefined;
        throw error;
      });
    }
    await projectLoad;
    projectName = nextProject.name ?? "";
  };
  // Never written by review, consolidation or the correction detector — see
  // store/standing-instructions.ts for why provenance has to be structural.
  const standingStore = config.standingInstructionsEnabled !== false
    ? new StandingInstructions(path.join(globalDir, STANDING_FILE), undefined, undefined,
        shouldMigrateExtensionRoot ? path.join(legacyGlobalDir, STANDING_FILE) : undefined)
    : null;

  const initialization = createMemoryInitializer(async () => {
    if (!persistenceInitialized) {
      if (shouldMigrateExtensionRoot) await migrateMarkdownMemoryFiles(legacyGlobalDir, globalDir);
      persistenceInitialized = true;
    }

    await measureLifecycle("session-start.load", async () => {
      await store.loadFromDisk();
    });
  }, async (ctx) => {
    await bindProjectFromCwd(ctx.cwd);
  });

  const ensureMemoryReady: EnsureMemoryReady = (ctx, signal) => initialization.ensure(ctx, signal);
  const memoryPi = withMemoryInitialization(pi, initialization);

  // Skills and pinned instructions must be available even without a lookup.
  pi.on("session_start", async (_event, ctx) => {
    // Pinned directives must not depend on memory migration being healthy.
    if (standingStore) await standingStore.load();
    await ensureMemoryReady(ctx);
    refreshSkillProjectContext(ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject a frozen Markdown memory snapshot ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptContext = await buildPromptContext(config, store, projectStoreRef(), projectNameRef(), standingStore);

    if (promptContext) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + promptContext,
      };
    }
  });

  // ── 3. Register Markdown memory write tools ──
  registerMarkdownMemoryTool(memoryPi, store, projectStoreRef, bindProjectFromCwd);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStoreRef, config, {
    projectName: projectNameRef,
    ensureMemoryReady,
  });

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStoreRef, config, null, projectNameRef, { ensureMemoryReady });

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  // Keep the failure in the tool result regardless; session-console logging is
  // separately configurable for users who already monitor tool results (#135).
  const runAutoConsolidation = async (
    target: "memory" | "user" | "failure",
    targetStore: MemoryStore,
    toolTarget: "memory" | "user" | "failure" | "project",
    signal?: AbortSignal,
  ) => {
    const result = await triggerConsolidation(
      pi,
      targetStore,
      target,
      signal,
      config.consolidationTimeoutMs,
      toolTarget,
      config,
    );
    if (result.deferred) {
      console.info(`⏳ Auto-consolidation for '${toolTarget}' deferred: ${result.error ?? "another session holds the consolidation lock"}`);
    } else if (shouldWarnAutoConsolidationFailure(config.autoConsolidationWarnOnFailure, result.consolidated)) {
      console.warn(`⚠️ Auto-consolidation failed for '${toolTarget}': ${result.error ?? "no reason reported"}`);
    }
    return result;
  };

  store.setConsolidator((target, signal) => runAutoConsolidation(target, store, target, signal));
  configureProjectStore = (candidate) => {
    if (!candidate) return;
    candidate.setConsolidator((target, signal) =>
      runAutoConsolidation(target, candidate, target === "memory" ? "project" : target, signal),
    );
  };
  configureProjectStore(projectStore);
  registerConsolidateCommand(memoryPi, store, config.consolidationTimeoutMs, projectStoreRef, projectNameRef, config);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStoreRef, config, null, projectNameRef, { ensureMemoryReady });

  // ── 9. Register commands ──
  registerInsightsCommand(memoryPi, store, projectStoreRef, projectNameRef);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(memoryPi, store);
  registerSwitchProjectCommand(pi, config);
  registerLearnMemoryCommand(pi);
  registerPreviewContextCommand(memoryPi, store, projectStoreRef, projectNameRef, config, standingStore);
  if (standingStore) registerStandingPinCommand(pi, standingStore);
  registerJsonlSessionSearchTool(pi);

  // Registered after flush so pending memory operations finish before shutdown.
  pi.on("session_shutdown", async () => {
    await initialization.close();
  });
}
