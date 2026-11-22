import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { messageOf } from "../shared/errors";
import type { DifftasticStatus, SyntaxChange, SyntaxDiff } from "../shared/protocol";

const PROBE_TIMEOUT_MS = 5_000;
const DIFF_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

const sideSchema = z.object({
  line_number: z.number().int(),
  changes: z.array(z.object({ start: z.number().int(), end: z.number().int(), highlight: z.string() })),
});
const fileSchema = z.object({
  aligned_lines: z.array(z.tuple([z.number().int().nullable(), z.number().int().nullable()])).default([]),
  chunks: z.array(z.array(z.object({ lhs: sideSchema.optional(), rhs: sideSchema.optional() }))).default([]),
  language: z.string(),
});

/** Runs the `difft` on the daemon's PATH; installing or removing it shows after a recheck. */
export class Difftastic {
  private probe: Promise<DifftasticStatus> | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  status(recheck: boolean): Promise<DifftasticStatus> {
    if (recheck || this.probe == null) this.probe = probeDifft(this.env);
    return this.probe;
  }

  async diff(path: string, original: string, modified: string): Promise<SyntaxDiff> {
    const status = await this.status(false);
    if (status.status === "missing") throw new Error(status.reason);
    const scratch = await mkdtemp(join(tmpdir(), "review-assist-difft-"));
    try {
      // Same file name on both sides: difftastic picks the language from it.
      const name = basename(path);
      const oldFile = join(scratch, "old", name);
      const newFile = join(scratch, "new", name);
      await Promise.all([mkdir(join(scratch, "old")), mkdir(join(scratch, "new"))]);
      await Promise.all([writeFile(oldFile, original), writeFile(newFile, modified)]);
      const output = await run(["--display", "json", oldFile, newFile], {
        // The JSON display is unstable and refuses to run without this.
        env: { ...this.env, DFT_UNSTABLE: "yes" },
        timeout: DIFF_TIMEOUT_MS,
      });
      return parseSyntaxDiff(output, original, modified);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export function parseSyntaxDiff(output: string, original: string, modified: string): SyntaxDiff {
  const file = fileSchema.parse(JSON.parse(output));
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  const oldChanges: Record<string, SyntaxChange[]> = {};
  const newChanges: Record<string, SyntaxChange[]> = {};
  for (const line of file.chunks.flat()) {
    if (line.lhs != null) oldChanges[line.lhs.line_number] = inCharacters(line.lhs, oldLines);
    if (line.rhs != null) newChanges[line.rhs.line_number] = inCharacters(line.rhs, newLines);
  }
  return { language: file.language, aligned: file.aligned_lines, oldChanges, newChanges };
}

/** In character columns, with changes only whitespace apart joined. */
function inCharacters(side: z.infer<typeof sideSchema>, lines: readonly string[]): SyntaxChange[] {
  const line = lines[side.line_number] ?? "";
  const bytes = Buffer.from(line, "utf8");
  const column = (byte: number): number => bytes.subarray(0, byte).toString("utf8").length;
  const joined: SyntaxChange[] = [];
  for (const { start, end, highlight } of [...side.changes].sort((a, b) => a.start - b.start)) {
    const change = { start: column(start), end: column(end), highlight };
    const last = joined[joined.length - 1];
    if (last != null && line.slice(last.end, change.start).trim() === "") joined[joined.length - 1] = { ...last, end: change.end };
    else joined.push(change);
  }
  return joined;
}

async function probeDifft(env: NodeJS.ProcessEnv): Promise<DifftasticStatus> {
  try {
    const output = await run(["--version"], { env, timeout: PROBE_TIMEOUT_MS });
    const version = /^Difftastic (\S+)/m.exec(output)?.[1];
    if (version == null) return { status: "missing", reason: `\`difft --version\` printed something unexpected: ${output.trim()}` };
    return { status: "available", version };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing", reason: "`difft` isn't on the PATH of the machine running Paseo." };
    }
    return { status: "missing", reason: `\`difft\` didn't run: ${messageOf(error)}` };
  }
}

function run(args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("difft", args, { ...options, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout) =>
      error == null ? resolve(stdout) : reject(error),
    );
  });
}
