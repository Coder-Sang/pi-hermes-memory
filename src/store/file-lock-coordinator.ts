import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Cross-process lock backed by atomic directory creation, without SQLite. */
export interface FileLockLease {
  token: string;
  release: () => void;
  renew: () => boolean;
}

interface Owner {
  token: string;
  pid: number;
  timestamp: number;
}

const shared = new Map<string, FileLockCoordinator>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class FileLockCoordinator {
  constructor(private readonly root: string) {}

  static shared(root: string): FileLockCoordinator {
    const resolved = path.resolve(root);
    let coordinator = shared.get(resolved);
    if (!coordinator) {
      coordinator = new FileLockCoordinator(resolved);
      shared.set(resolved, coordinator);
    }
    return coordinator;
  }

  private lockDir(key: string): string {
    return path.join(this.root, createHash("sha256").update(key).digest("hex") + ".lock");
  }

  private readOwner(dir: string): Owner | null {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")) as Owner;
      return typeof owner.token === "string" && Number.isSafeInteger(owner.pid)
        && Number.isFinite(owner.timestamp) ? owner : null;
    } catch {
      return null;
    }
  }

  tryAcquire(key: string, { staleMs }: { staleMs: number }): FileLockLease | null {
    fs.mkdirSync(this.root, { recursive: true });
    const dir = this.lockDir(key);
    const token = randomUUID();
    const claim = (): boolean => {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      try {
        fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ token, pid: process.pid, timestamp: Date.now() }), { flag: "wx", mode: 0o600 });
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return true;
    };

    if (!claim()) {
      const owner = this.readOwner(dir);
      // A newly-created directory may not contain owner.json yet. Allow its
      // writer time to finish before considering it abandoned.
      let age: number;
      try {
        age = Date.now() - fs.statSync(dir).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (!owner && age < 60_000) return null;
      if (owner && alive(owner.pid) && (staleMs <= 0 || Date.now() - owner.timestamp < staleMs)) return null;
      // Rename out of the namespace before removing: an old lease cannot
      // delete the new holder's directory when it eventually releases.
      const retired = `${dir}.${token}.retired`;
      try {
        if (owner && this.readOwner(dir)?.token !== owner.token) return null;
        fs.renameSync(dir, retired);
        fs.rmSync(retired, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!claim()) return null;
    }

    const owns = () => this.readOwner(dir)?.token === token;
    return {
      token,
      renew: () => {
        if (!owns()) return false;
        fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ token, pid: process.pid, timestamp: Date.now() }));
        return true;
      },
      release: () => {
        if (!owns()) return;
        const retired = `${dir}.${token}.retired`;
        try {
          fs.renameSync(dir, retired);
          fs.rmSync(retired, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }
}
