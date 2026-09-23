import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MEMORY_FILE, USER_FILE, STANDING_FILE } from "./constants.js";

/** Preserve existing Markdown memories from the pre-extension directory. Never overwrite new files. */
export async function migrateMarkdownMemoryFiles(legacyRoot: string, targetRoot: string): Promise<void> {
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) return;
  await fs.mkdir(targetRoot, { recursive: true });
  for (const name of [MEMORY_FILE, USER_FILE, "failures.md", STANDING_FILE]) {
    try {
      await fs.copyFile(path.join(legacyRoot, name), path.join(targetRoot, name),
        fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
}
