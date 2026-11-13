import { createHash } from "node:crypto";
import { ENTRY_DELIMITER } from "../constants.js";
import type { MemoryCategory } from "../types.js";

export const MEMORY_TARGETS = ["memory", "user", "project", "failure"] as const;
export const MEMORY_CATEGORIES = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const;
export type MemoryTarget = typeof MEMORY_TARGETS[number];
export type MemoryStorageTarget = Exclude<MemoryTarget, "project">;

export interface MarkdownMemoryEntry {
  content: string;
  offset: number;
  length: number;
  category?: MemoryCategory;
}

export interface MarkdownMemoryView {
  content: string;
  totalChars: number;
  revision: string;
  entries: readonly MarkdownMemoryEntry[];
}

/** Build a stable, metadata-free view; offsets count Unicode code points. */
export function markdownMemoryView(contents: readonly string[]): MarkdownMemoryView {
  let offset = 0;
  const separatorLength = Array.from(ENTRY_DELIMITER).length;
  const entries = contents.map((content, index): MarkdownMemoryEntry => {
    if (index > 0) offset += separatorLength;
    const length = Array.from(content).length;
    const tag = /^\[([^\]]+)\]/u.exec(content)?.[1];
    const category = MEMORY_CATEGORIES.find((candidate) => candidate === tag);
    const entry = { content, offset, length, ...(category ? { category } : {}) };
    offset += length;
    return entry;
  });
  const content = contents.join(ENTRY_DELIMITER);
  return {
    content, totalChars: offset, entries,
    revision: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

export function memorySearchTerms(query: string): string[] {
  return [...new Set(query.normalize("NFKC").toLowerCase().trim().split(/\s+/u).filter(Boolean))];
}

/** Match literal terms only; user input is never a regular expression. */
export function matchesMemoryEntry(entry: MarkdownMemoryEntry, terms: readonly string[]): boolean {
  const normalized = entry.content.normalize("NFKC").toLowerCase();
  return terms.every((term) => normalized.includes(term));
}
