import { type ParsedDiff, parseDiff } from "../shared/diff";
import { applyHunks } from "../shared/sides";
import { hasObject, readBlob } from "./git";

interface KnownDiff {
  readonly root: string;
  readonly base: string;
  readonly raw: string;
  parsed?: ParsedDiff;
}

const MAX_KNOWN_DIFFS = 16;

export class TreeFiles {
  private readonly diffs = new Map<string, KnownDiff>();

  remember(snapshot: { root: string; tree: string; base: { sha: string }; raw: string }): void {
    this.diffs.delete(snapshot.tree);
    this.diffs.set(snapshot.tree, { root: snapshot.root, base: snapshot.base.sha, raw: snapshot.raw });
    if (this.diffs.size > MAX_KNOWN_DIFFS) this.diffs.delete(this.diffs.keys().next().value ?? "");
  }

  async read(root: string, tree: string, path: string): Promise<string> {
    try {
      return await readBlob(root, tree, path);
    } catch (error) {
      // Nothing references a diff's tree, so git prunes it; history keeps the base.
      const known = this.diffs.get(tree);
      if (known?.root !== root || (await hasObject(root, tree))) throw error;
      known.parsed ??= parseDiff(known.raw);
      const file = known.parsed.files.find((candidate) => candidate.newPath === path);
      if (file == null) throw error;
      return applyHunks(file.oldPath == null ? "" : await readBlob(root, known.base, file.oldPath), file);
    }
  }
}
