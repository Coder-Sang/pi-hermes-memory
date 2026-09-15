import fs from "node:fs/promises";

export interface FileIdentity {
  dev: number;
  ino: number;
}

const LINK_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"]);
const COPY_BUFFER_SIZE = 64 * 1024;

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  const sourceState = await fs.lstat(source);
  try {
    await fs.link(source, target);
  } catch (error) {
    if (!LINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return copyExclusive(source, target, sourceState.mode & 0o777);
  }
  // Sources live in private staging/recovery paths and must stay stable during
  // publication. Reading identity from the source avoids claiming an external
  // successor that replaces the target immediately after link().
  return { dev: sourceState.dev, ino: sourceState.ino };
}

async function copyExclusive(source: string, target: string, mode: number): Promise<FileIdentity> {
  let sourceHandle: fs.FileHandle | undefined;
  let targetHandle: fs.FileHandle | undefined;
  let identity: FileIdentity | undefined;
  let created = false;
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
      if (!identity) {
        cleanupErrors.push(new Error(`Preserved ${target}: cannot determine ownership`));
      } else {
        try {
          const current = await fs.lstat(target);
          if (sameIdentity(current, identity)) {
            await fs.unlink(target);
          } else {
            cleanupErrors.push(new Error(`Preserved ${target}: file identity changed`));
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(cleanupError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        [error, ...cleanupErrors].map((item) => item instanceof Error ? item.message : String(item)).join("; "),
        { cause: error },
      );
    }
    throw error;
  }
}
