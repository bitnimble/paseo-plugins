import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// readDiff inherits the environment too, so the user's git config can't leak into either side.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

const scratch: string[] = [];

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function writeIn(root: string, path: string, content: string | Buffer): void {
  writeFileSync(join(root, path), content);
}

export function scratchDirectory(): string {
  // Real path: the daemon admits a root only if git reports it back unchanged, and tmpdir can be a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-assist-test-")));
  scratch.push(dir);
  return dir;
}

export function freshRepo(): string {
  const dir = scratchDirectory();
  gitIn(dir, "init", "-q", "-b", "main");
  return dir;
}

export function removeScratch(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}
