export type TreeRow<Item> =
  | { readonly kind: "directory"; readonly path: string; readonly name: string; readonly depth: number; readonly collapsed: boolean }
  | { readonly kind: "file"; readonly item: Item; readonly name: string; readonly depth: number };

interface Directory<Item> {
  readonly directories: Map<string, Directory<Item>>;
  readonly files: { readonly name: string; readonly item: Item }[];
}

/**
 * Items as a directory tree, directories first and each level sorted by name. A directory holding
 * only one directory shares its row, as `a/b`; rows under a `collapsed` path are left out.
 */
export function treeRows<Item>(
  items: readonly Item[],
  pathOf: (item: Item) => string,
  collapsed: ReadonlySet<string>,
): TreeRow<Item>[] {
  const root = directory<Item>();
  for (const item of items) {
    const segments = pathOf(item).split("/");
    const name = segments.pop() ?? "";
    let parent = root;
    for (const segment of segments) {
      let child = parent.directories.get(segment);
      if (child == null) {
        child = directory();
        parent.directories.set(segment, child);
      }
      parent = child;
    }
    parent.files.push({ name, item });
  }
  const rows: TreeRow<Item>[] = [];
  appendRows(root, "", 0, collapsed, rows);
  return rows;
}

/** Items in the order `treeRows` lists them, nothing collapsed. */
export function treeOrder<Item>(items: readonly Item[], pathOf: (item: Item) => string): Item[] {
  return treeRows(items, pathOf, new Set()).flatMap((row) => (row.kind === "file" ? [row.item] : []));
}

function appendRows<Item>(
  parent: Directory<Item>,
  prefix: string,
  depth: number,
  collapsed: ReadonlySet<string>,
  rows: TreeRow<Item>[],
): void {
  for (const [segment, start] of sortedEntries(parent.directories)) {
    let name = segment;
    let node = start;
    while (node.files.length === 0 && node.directories.size === 1) {
      const [[next, child]] = node.directories;
      name = `${name}/${next}`;
      node = child;
    }
    const path = `${prefix}${name}`;
    const isCollapsed = collapsed.has(path);
    rows.push({ kind: "directory", path, name, depth, collapsed: isCollapsed });
    if (!isCollapsed) appendRows(node, `${path}/`, depth + 1, collapsed, rows);
  }
  const files = [...parent.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, item } of files) rows.push({ kind: "file", item, name, depth });
}

function directory<Item>(): Directory<Item> {
  return { directories: new Map(), files: [] };
}

function sortedEntries<Value>(map: ReadonlyMap<string, Value>): [string, Value][] {
  return [...map].sort(([a], [b]) => a.localeCompare(b));
}
