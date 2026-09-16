import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface FileIdentity {
  dev: number;
  ino: number;
}

export type FileContent = { kind: "file"; size: number; sha256: string }
  | { kind: "symlink"; link: string };

export interface FileSnapshot {
  identity: FileIdentity;
  content: FileContent;
}

export const PUBLICATION_RECOVERY_PREFIX = ".publish-recovery-";

export class PreservedFileError extends AggregateError {
  constructor(cause: unknown, readonly preservedPaths: string[], errors: unknown[] = []) {
    super([cause, ...errors], [cause, ...errors].map(String).join("; ")
      + `; recovery files preserved at ${preservedPaths.join(", ")}`, { cause });
  }
}

export function preservedFilePaths(error: unknown): string[] {
  return error instanceof PreservedFileError ? error.preservedPaths : [];
}

const LINK_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV", "EMLINK"]);
const COPY_BUFFER_SIZE = 64 * 1024;

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameState(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameContent(left: FileContent, right: FileContent): boolean {
  return left.kind === "file" && right.kind === "file"
    ? left.size === right.size && left.sha256 === right.sha256
    : left.kind === "symlink" && right.kind === "symlink" && left.link === right.link;
}

/** Read a bounded-memory fingerprint without accepting a replaced or changing file. */
export async function readFileSnapshot(file: string): Promise<FileSnapshot> {
  const before = await fs.lstat(file);
  let content: FileContent;
  if (before.isSymbolicLink()) {
    content = { kind: "symlink", link: await fs.readlink(file) };
  } else {
    if (!before.isFile()) throw new Error(`Not a regular publication file: ${file}`);
    const handle = await fs.open(file, "r");
    try {
      if (!sameState(before, await handle.stat())) throw new Error(`File changed while opening: ${file}`);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
      let size = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (size !== before.size || !sameState(before, await handle.stat())) {
        throw new Error(`File changed while reading: ${file}`);
      }
      content = { kind: "file", size, sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  }
  if (!sameState(before, await fs.lstat(file))) throw new Error(`File changed while verifying: ${file}`);
  return { identity: { dev: before.dev, ino: before.ino }, content };
}

export async function verifyFileSnapshot(file: string, expected: FileSnapshot): Promise<void> {
  const actual = await readFileSnapshot(file);
  if (!sameIdentity(actual.identity, expected.identity) || !sameContent(actual.content, expected.content)) {
    throw new Error(`Publication identity or content changed: ${file}`);
  }
}

/**
 * Isolate before checking ownership: never unlink a shared pathname using a
 * stale stat. Unrecognized files survive in a private sibling directory even
 * when restoring their original pathname fails or loses to another creator.
 */
export async function removePublishedFile(target: string, expected: FileSnapshot): Promise<void> {
  let directory: string;
  try {
    directory = await fs.mkdtemp(path.join(path.dirname(target), PUBLICATION_RECOVERY_PREFIX));
  } catch (error) {
    throw new PreservedFileError(error, [target]);
  }
  const isolated = path.join(directory, path.basename(target));
  try {
    await fs.rename(target, isolated);
  } catch (error) {
    try { await fs.rmdir(directory); } catch {}
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new PreservedFileError(error, [target]);
  }
  try {
    await verifyFileSnapshot(isolated, expected);
    await fs.unlink(isolated);
  } catch (error) {
    const restoreErrors: unknown[] = [];
    try {
      const snapshot = await readFileSnapshot(isolated);
      let identity: FileIdentity;
      if (snapshot.content.kind === "symlink") {
        await fs.symlink(snapshot.content.link, target);
        const state = await fs.lstat(target);
        identity = { dev: state.dev, ino: state.ino };
      } else {
        // No recursive cleanup: a failed restoration keeps both copies.
        identity = await linkOrCopy(isolated, target, false);
      }
      await verifyFileSnapshot(target, { identity, content: snapshot.content });
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }
    throw new PreservedFileError(error, [isolated, target], restoreErrors);
  }
  try { await fs.rmdir(directory); } catch { /* The owned file is already gone. */ }
}

/**
 * Publish a caller-owned, stable source without replacing an existing target.
 * Hard links provide atomic visibility. Filesystems without hard links use an
 * exclusive create and bounded copy; readers may see partial content on that
 * path, and process interruption may leave an incomplete file.
 *
 * The caller retains the source until publication succeeds. Return the created
 * target's identity so rollback also works when a copy has a different inode.
 */
export async function publishFile(source: string, target: string): Promise<FileIdentity> {
  return linkOrCopy(source, target, true);
}

async function linkOrCopy(source: string, target: string, cleanup: boolean): Promise<FileIdentity> {
  const sourceState = await fs.lstat(source);
  try {
    await fs.link(source, target);
  } catch (error) {
    if (!LINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return copyExclusive(source, target, sourceState.mode & 0o777, cleanup);
  }
  // Sources live in private staging/recovery paths and must stay stable during
  // publication. Reading identity from the source avoids claiming an external
  // successor that replaces the target immediately after link().
  return { dev: sourceState.dev, ino: sourceState.ino };
}

async function copyExclusive(source: string, target: string, mode: number, cleanup: boolean): Promise<FileIdentity> {
  let sourceHandle: fs.FileHandle | undefined;
  let targetHandle: fs.FileHandle | undefined;
  let identity: FileIdentity | undefined;
  let created = false;
  const writtenHash = createHash("sha256");
  let writtenSize = 0;
  try {
    sourceHandle = await fs.open(source, "r");
    targetHandle = await fs.open(target, "wx", mode);
    created = true;
    const state = await targetHandle.stat();
    identity = { dev: state.dev, ino: state.ino };

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await targetHandle.write(buffer, offset, bytesRead - offset, null);
        if (bytesWritten === 0) {
          throw Object.assign(new Error(`Copy to ${target} made no write progress`), { code: "EIO" });
        }
        writtenHash.update(buffer.subarray(offset, offset + bytesWritten));
        writtenSize += bytesWritten;
        offset += bytesWritten;
      }
    }

    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    if (!sameIdentity(await fs.lstat(target), identity)) {
      throw new Error(`Publication target was replaced during copy: ${target}`);
    }
    return identity;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const handle of [targetHandle, sourceHandle]) {
      if (!handle) continue;
      try { await handle.close(); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (created) {
      if (!identity || !cleanup) {
        cleanupErrors.push(new PreservedFileError(new Error("Cannot safely clean publication"), [target]));
      } else {
        try {
          await removePublishedFile(target, {
            identity,
            content: { kind: "file", size: writtenSize, sha256: writtenHash.digest("hex") },
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new PreservedFileError(error,
        [...new Set(cleanupErrors.flatMap(preservedFilePaths))], cleanupErrors);
    }
    throw error;
  }
}
