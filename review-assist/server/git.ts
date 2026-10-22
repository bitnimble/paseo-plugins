import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { type DiffFile, type FileFacts, parseDiff } from "../shared/diff";
import type { BlobPreview, DiffBase, DiffMode } from "../shared/protocol";

export interface DiffSnapshot {
  readonly raw: string;
  readonly hash: string;
  readonly base: DiffBase;
  readonly root: string;
  /** Tree of exactly what the diff's new side holds, untracked files included. */
  readonly tree: string;
  readonly facts: FileFacts;
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BLOB_PREFIX = /^[0-9a-f]{7,64}$/;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:.*\n)*?size (\d+)\n/;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

const STABLE_OUTPUT = [
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.suppressBlankEmpty=false",
];

/**
 * The working tree, untracked files included, against `HEAD` or the merge-base with a branch.
 * Reads through a copy of the index so the user's staging area is never touched.
 */
export async function readDiff(directory: string, mode: DiffMode): Promise<DiffSnapshot> {
  const root = await repoRoot(directory);
  const base = await resolveBase(root, mode);
  const scratch = await mkdtemp(join(tmpdir(), "review-assist-"));
  try {
    const index = join(scratch, "index");
    const realIndex = resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
    // Copying keeps the stat cache, so `add -A` hashes only files that changed. Its timestamps too:
    // git rechecks same-second edits only while the index looks no older than them.
    await cp(realIndex, index, { preserveTimestamps: true }).catch(() => undefined);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    // Exit 1 means some paths could not be indexed (an unreadable file, a nested repository without
    // commits); everything else is staged, and failing outright would hide the whole diff.
    await git(root, ["add", "-A", "--ignore-errors"], { env, partialExit: 1 });
    const raw = await git(
      root,
      [
        ...STABLE_OUTPUT,
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--unified=3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        base.sha,
      ],
      { env },
    );
    const tree = (await git(root, ["write-tree"], { env })).trim();
    const { files } = parseDiff(raw);
    const [generated, sizes, lfs] = await Promise.all([
      generatedAttributes(root, files),
      binarySizes(root, files),
      lfsPaths(root, files),
    ]);
    const facts = { generated, sizes, lfs };
    return { raw, hash: createHash("sha256").update(raw).digest("hex").slice(0, 32), base, root, tree, facts };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function generatedAttributes(root: string, files: readonly DiffFile[]): Promise<FileFacts["generated"]> {
  if (files.length === 0) return {};
  const input = files.map(({ path }) => `${path}\0`).join("");
  const fields = (await git(root, ["check-attr", "-z", "--stdin", "linguist-generated"], { input })).split("\0");
  const generated: Record<string, boolean> = {};
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const value = fields[i + 2];
    if (value === "set" || value === "true") generated[fields[i]] = true;
    else if (value === "unset" || value === "false") generated[fields[i]] = false;
  }
  return generated;
}

async function lfsPaths(root: string, files: readonly DiffFile[]): Promise<string[]> {
  const candidates = files.filter((file) => !file.binary);
  if (candidates.length === 0) return [];
  const input = candidates.map(({ path }) => `${path}\0`).join("");
  const fields = (await git(root, ["check-attr", "-z", "--stdin", "filter"], { input })).split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "lfs") paths.push(fields[i]);
  }
  return paths;
}

async function binarySizes(root: string, files: readonly DiffFile[]): Promise<FileFacts["sizes"]> {
  const binary = files.filter((file) => file.binary);
  if (binary.length === 0) return {};
  // A side the file lacks has no id; asking for an all-zero one keeps the answers in step with the files.
  const input = binary.flatMap(({ oldBlob, newBlob }) => [oldBlob ?? "0000000", newBlob ?? "0000000"]).join("\n");
  const lines = (await git(root, ["cat-file", "--batch-check=%(objectsize)"], { input: `${input}\n` })).split("\n");
  const size = (line: string | undefined) => (/^\d+$/.test(line ?? "") ? Number(line) : 0);
  return Object.fromEntries(
    binary.map((file, i) => [file.path, { before: size(lines[2 * i]), after: size(lines[2 * i + 1]) }]),
  );
}

export async function repoRoot(directory: string): Promise<string> {
  return (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
}

/** `tree` may also be a commit. */
export async function readBlob(root: string, tree: string, path: string): Promise<string> {
  if (!OBJECT_ID.test(tree)) {
    throw new Error(`Not an object id: ${tree}`);
  }
  const text = await git(root, ["cat-file", "blob", `${tree}:${path}`]);
  if (text.length > MAX_BLOB_BYTES) {
    throw new Error(`${path} is larger than ${MAX_BLOB_BYTES} bytes`);
  }
  return text;
}

export async function previewBlob(
  root: string,
  tree: string,
  path: string,
  blob: string | null,
  lfs = false,
): Promise<BlobPreview> {
  const object = await blobObject(root, tree, path, blob);
  if (Number(await git(root, ["cat-file", "-s", object])) > MAX_PREVIEW_BYTES) {
    return { status: "binary" };
  }
  let bytes = await gitBytes(root, ["cat-file", "blob", object]);
  const pointer = lfs ? LFS_POINTER.exec(bytes.toString("utf8")) : null;
  if (pointer != null) {
    if (Number(pointer[1]) > MAX_PREVIEW_BYTES) return { status: "binary" };
    bytes = await gitBytes(root, ["lfs", "smudge", "--", path], {
      input: bytes,
      // A skip set for checkouts would hand the pointer back unchanged.
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "0" },
    });
  }
  const mime = IMAGE_TYPES[extname(path).toLowerCase()];
  if (mime != null) {
    return { status: "image", uri: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length };
  }
  // git's own binary test, so text it called binary can only have come from an attribute such as -diff.
  return bytes.subarray(0, 8000).includes(0) ? { status: "binary" } : { status: "text" };
}

/** `blob` is the diff's abbreviated id for `tree:path`, used once `tree` is gone. */
async function blobObject(root: string, tree: string, path: string, blob: string | null): Promise<string> {
  if (!OBJECT_ID.test(tree) || (blob != null && !BLOB_PREFIX.test(blob))) {
    throw new Error(`Not an object id: ${tree} ${blob}`);
  }
  return git(root, ["cat-file", "-e", `${tree}:${path}`]).then(
    () => `${tree}:${path}`,
    (error: unknown) => {
      if (blob == null) throw error;
      return blob;
    },
  );
}

export async function hasObject(root: string, id: string): Promise<boolean> {
  return OBJECT_ID.test(id) && (await git(root, ["cat-file", "-e", id]).then(() => true, () => false));
}

async function resolveBase(root: string, mode: DiffMode): Promise<DiffBase> {
  const head = await revParse(root, "HEAD");
  if (head == null) {
    const emptyTree = (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
    return { label: "empty repository", sha: emptyTree };
  }
  if (mode.kind === "uncommitted") {
    return { label: "HEAD", sha: head };
  }
  const branch = mode.branch ?? (await defaultBranch(root));
  if (branch == null) {
    return { label: "HEAD (no default branch found)", sha: head };
  }
  const tip = await revParse(root, branch);
  if (tip == null) {
    throw new Error(`No branch named ${branch}`);
  }
  const mergeBase = await git(root, ["merge-base", "HEAD", tip]).then(
    (out) => out.trim(),
    () => null,
  );
  return mergeBase == null
    ? { label: `HEAD (no common history with ${branch})`, sha: head }
    : { label: branch, sha: mergeBase };
}

async function defaultBranch(root: string): Promise<string | null> {
  const remoteHead = await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).then(
    (out) => out.trim() || null,
    () => null,
  );
  // Local first: worktrees branch off local main, and a stale origin/main's older merge-base
  // would pull main's own commits into the diff.
  const names = [remoteHead?.replace(/^origin\//, ""), "main", "master"];
  for (const name of names) {
    if (name != null && (await revParse(root, `refs/heads/${name}`)) != null) {
      return name;
    }
  }
  return remoteHead;
}

export async function listBranches(directory: string): Promise<{ defaultBranch: string | null; branches: string[] }> {
  const [out, defaultName] = await Promise.all([
    git(directory, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)%00%(symref)",
      "refs/heads",
      "refs/remotes",
    ]),
    defaultBranch(directory),
  ]);
  const branches = out
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([name, symref]) => name !== "" && symref === "")
    .map(([name]) => name);
  return { defaultBranch: defaultName, branches };
}

async function revParse(root: string, ref: string): Promise<string | null> {
  return git(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]).then(
    (out) => out.trim(),
    () => null,
  );
}

function gitBytes(
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {},
): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: options.env ?? process.env, encoding: "buffer", maxBuffer: 2 * MAX_PREVIEW_BYTES },
      (error, stdout, stderr) => {
        if (error != null) fail(new Error(stderr.toString().trim() || error.message));
        else done(stdout);
      },
    );
    if (options.input != null) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}

function git(
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; partialExit?: number; input?: string } = {},
): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: options.env ?? process.env, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error != null && error.code !== options.partialExit) {
          fail(new Error(stderr.trim() || error.message));
          return;
        }
        if (error != null) {
          console.error(`git ${args.join(" ")}: ${stderr.trim()}`);
        }
        done(stdout);
      },
    );
    if (options.input != null) {
      // git can exit before reading all of it; the exit code reports that, not an EPIPE crash.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}
