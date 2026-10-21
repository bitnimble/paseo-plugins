export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
  /** Raw `\ No newline at end of file` marker that follows this line in the patch. */
  readonly noNewlineMarker: string | null;
}

export interface DiffHunk {
  readonly id: string;
  readonly fileIndex: number;
  readonly header: string;
  readonly heading: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffFile {
  readonly index: number;
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  /** Abbreviated ids of each side's content, from the `index` line. */
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  readonly binary: boolean;
  /** Kept out of the agent's prompt and shown in its own section. */
  readonly generated: boolean;
  /** Bytes gained or lost, for a binary file whose sizes are known. */
  readonly sizeChange: number | null;
  readonly header: readonly string[];
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
  readonly hunks: ReadonlyMap<string, DiffHunk>;
  readonly trailingNewline: boolean;
}

/** What a file's patch text does not say, by path. */
export interface FileFacts {
  /** Paths whose `linguist-generated` attribute is set (true) or unset (false); others are guessed by name. */
  readonly generated: Readonly<Record<string, boolean>>;
  /** Binary files' sizes in bytes, 0 for a side the file does not have. */
  readonly sizes: Readonly<Record<string, { readonly before: number; readonly after: number }>>;
}

export const NO_FACTS: FileFacts = { generated: {}, sizes: {} };

const LOCKFILES = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "Package.resolved",
  "Pipfile.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "flake.lock",
  "go.sum",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "packages.lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock",
]);

// The heading is copied verbatim from the source, so it can hold \r, U+2028 and U+2029, which `.` skips.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([\s\S]*)$/;

/** Parses `git diff` output losslessly: `serializeDiff(parseDiff(raw)) === raw`. */
export function parseDiff(raw: string, facts: FileFacts = NO_FACTS): ParsedDiff {
  const lines = raw.split("\n");
  const trailingNewline = raw.endsWith("\n");
  if (trailingNewline || raw === "") {
    lines.pop();
  }

  const files: DiffFile[] = [];
  const hunks = new Map<string, DiffHunk>();
  let cursor = 0;
  while (cursor < lines.length) {
    if (!lines[cursor].startsWith("diff --git ")) {
      throw new Error(`Unexpected diff line ${cursor + 1}: ${lines[cursor].slice(0, 80)}`);
    }
    const fileIndex = files.length;
    const header = [lines[cursor++]];
    while (
      cursor < lines.length &&
      !lines[cursor].startsWith("diff --git ") &&
      !lines[cursor].startsWith("@@ ")
    ) {
      header.push(lines[cursor++]);
    }

    const fileHunks: DiffHunk[] = [];
    while (cursor < lines.length && lines[cursor].startsWith("@@ ")) {
      const parsed = parseHunk(lines, cursor, fileIndex, `h${hunks.size}`);
      cursor = parsed.next;
      hunks.set(parsed.hunk.id, parsed.hunk);
      fileHunks.push(parsed.hunk);
    }
    files.push(describeFile(fileIndex, header, fileHunks, facts));
  }
  return { files, hunks, trailingNewline };
}

function looksGenerated(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LOCKFILES.has(name) || /\.min\.(js|css)$/.test(name) || /\.(js|css)\.map$/.test(name);
}

export function serializeDiff(diff: Pick<ParsedDiff, "files" | "trailingNewline">): string {
  const out: string[] = [];
  for (const file of diff.files) {
    out.push(...file.header);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        out.push(LINE_PREFIX[line.kind] + line.text);
        if (line.noNewlineMarker != null) {
          out.push(line.noNewlineMarker);
        }
      }
    }
  }
  const body = out.join("\n");
  return diff.trailingNewline && out.length > 0 ? `${body}\n` : body;
}

export const LINE_PREFIX: Readonly<Record<DiffLineKind, string>> = { context: " ", add: "+", del: "-" };

export function isChange(line: DiffLine): boolean {
  return line.kind !== "context";
}

function parseHunk(
  lines: readonly string[],
  start: number,
  fileIndex: number,
  id: string,
): { hunk: DiffHunk; next: number } {
  const header = lines[start];
  const match = HUNK_HEADER.exec(header);
  if (match == null) {
    throw new Error(`Malformed hunk header on line ${start + 1}: ${header}`);
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] == null ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] == null ? 1 : Number(match[4]);

  const body: DiffLine[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  let cursor = start + 1;
  const attachMarker = () => {
    const previous = body.pop();
    if (previous == null) {
      throw new Error(`No-newline marker before any line on line ${cursor + 1}`);
    }
    body.push({ ...previous, noNewlineMarker: lines[cursor] });
    cursor++;
  };

  while (oldSeen < oldCount || newSeen < newCount) {
    if (cursor >= lines.length) {
      throw new Error(`Hunk starting on line ${start + 1} ends early`);
    }
    const line = lines[cursor];
    const text = line.slice(1);
    switch (line[0]) {
      case " ":
        body.push(diffLine("context", text, oldStart + oldSeen++, newStart + newSeen++));
        break;
      case "-":
        body.push(diffLine("del", text, oldStart + oldSeen++, null));
        break;
      case "+":
        body.push(diffLine("add", text, null, newStart + newSeen++));
        break;
      case "\\":
        attachMarker();
        continue;
      default:
        throw new Error(`Unexpected hunk line ${cursor + 1}: ${line.slice(0, 80)}`);
    }
    cursor++;
  }
  if (cursor < lines.length && lines[cursor].startsWith("\\")) {
    attachMarker();
  }

  const heading = match[5];
  return { hunk: { id, fileIndex, header, heading, oldStart, newStart, lines: body }, next: cursor };
}

function diffLine(
  kind: DiffLineKind,
  text: string,
  oldNumber: number | null,
  newNumber: number | null,
): DiffLine {
  return { kind, text, oldNumber, newNumber, noNewlineMarker: null };
}

function describeFile(
  index: number,
  header: readonly string[],
  hunks: readonly DiffHunk[],
  facts: FileFacts,
): DiffFile {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let status: DiffFileStatus = "modified";
  let oldBlob: string | null = null;
  let newBlob: string | null = null;
  let binary = false;
  for (const line of header) {
    if (line.startsWith("index ")) {
      const blobs = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
      oldBlob = blobId(blobs?.[1]);
      newBlob = blobId(blobs?.[2]);
    } else if (line.startsWith("--- ")) {
      oldPath = patchPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      newPath = patchPath(line.slice(4), "b/");
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      oldPath = unquote(line.slice(line.indexOf(" from ") + 6));
      status = line.startsWith("rename") ? "renamed" : "copied";
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      newPath = unquote(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("new file mode ")) {
      status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      status = "deleted";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binary = true;
    }
  }
  if (oldPath == null && newPath == null) {
    const path = pathFromGitHeader(header[0]);
    oldPath = status === "added" ? null : path;
    newPath = status === "deleted" ? null : path;
  }

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions++;
      if (line.kind === "del") deletions++;
    }
  }
  const path = newPath ?? oldPath ?? "";
  const generated = Object.hasOwn(facts.generated, path) ? facts.generated[path] : looksGenerated(path);
  const sizes = Object.hasOwn(facts.sizes, path) ? facts.sizes[path] : null;
  const sizeChange = binary && sizes != null ? sizes.after - sizes.before : null;
  return {
    index,
    path,
    oldPath,
    newPath,
    status,
    oldBlob,
    newBlob,
    binary,
    generated,
    sizeChange,
    header,
    hunks,
    additions,
    deletions,
  };
}

function blobId(id: string | undefined): string | null {
  return id == null || /^0+$/.test(id) ? null : id;
}

function patchPath(raw: string, prefix: string): string | null {
  // git appends a tab to `---`/`+++` names containing a space.
  const name = unquote(raw.endsWith("\t") ? raw.slice(0, -1) : raw);
  if (name === "/dev/null") {
    return null;
  }
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function pathFromGitHeader(line: string): string {
  const names = line.slice("diff --git ".length);
  if (names.startsWith('"')) {
    const end = quotedEnd(names);
    return unquote(names.slice(0, end + 1)).slice(2);
  }
  // Without a rename both names are the same path, so the line is `a/<p> b/<p>`.
  const half = (names.length - 1) / 2;
  return names.slice(2, half);
}

function quotedEnd(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") {
      i++;
    } else if (value[i] === '"') {
      return i;
    }
  }
  return value.length - 1;
}

const ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

/** Display-only: octal escapes decode as single bytes, which holds under `core.quotePath=false`. */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  return value
    .slice(1, -1)
    .replace(/\\([0-7]{3}|.)/g, (_, escape: string) =>
      escape.length === 3 ? String.fromCharCode(parseInt(escape, 8)) : (ESCAPES[escape] ?? escape),
    );
}
