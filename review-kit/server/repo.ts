import { execFile } from "node:child_process";

export function repoRoot(directory: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error != null) fail(new Error(stderr.trim() || error.message));
      else done(stdout.trim());
    });
  });
}
