import type { PluginTheme } from "@getpaseo/plugin";
import { hashText } from "../../shared/hash";
import type { LspMethod, MonacoAsset } from "../../shared/protocol";
import { createDetachedNode, injectMonaco } from "../web";
import type {
  DiffEditor,
  EditorContainer,
  IDisposable,
  Monaco,
  MonacoHover,
  MonacoLocation,
  MonacoModel,
  MonacoPosition,
  MonacoRange,
  MonacoUri,
} from "./api";
import { toHoverMarkdown, toLocations, toLspPosition, toMonacoRange } from "./convert";
import { THEME_NAME, type SyntaxPalette, monacoTheme } from "./theme";

export interface CodeSource {
  readonly root: string;
  readonly tree: string;
  readonly base: string;
}

export interface ReviewBridge {
  asset(asset: MonacoAsset): Promise<string>;
  file(input: { root: string; tree: string | null; path: string }): Promise<string>;
  /** Null when no language server handles the file. */
  lsp(input: {
    projectId: string;
    root: string;
    tree: string | null;
    path: string;
    method: LspMethod;
    params: Record<string, unknown>;
  }): Promise<unknown>;
}

interface ModelOwner {
  readonly root: string;
  readonly tree: string | null;
  readonly path: string;
  /** Per model line, its line in the tree's file; null when they are the same lines. */
  readonly treeLines: readonly (number | null)[] | null;
}

interface SharedModel {
  readonly model: MonacoModel;
  readonly treeKeys: Set<string>;
  users: number;
}

const MAX_REFERENCE_MODELS = 40;
const MAX_EAGER_TOKENIZED_LINES = 1000;
const ORIGINAL_SCHEME = "review-original";

class ReviewMonaco {
  private loading: Promise<Monaco> | null = null;
  private ready = false;
  private bridge: ReviewBridge | null = null;
  private onBridge: ((bridge: ReviewBridge) => void) | null = null;
  private readonly bridged = new Promise<ReviewBridge>((resolve) => {
    this.onBridge = resolve;
  });
  private readonly owners = new Map<string, ModelOwner>();
  private readonly modified = new Map<string, SharedModel>();
  /** Models holding a tree's file line for line, by tree and path, for peeks into it. */
  private readonly treeModels = new Map<string, string>();
  private readonly targets = new Map<string, MonacoModel>();
  private readonly registrations: IDisposable[] = [];
  private readonly featureRoots = new Map<string, { projectId: string; holders: number }>();
  private themeKey = "";
  private originals = 0;

  connect(bridge: ReviewBridge): void {
    this.bridge = bridge;
    this.onBridge?.(bridge);
  }

  get loaded(): boolean {
    return this.ready;
  }

  load(): Promise<Monaco> {
    this.loading ??= this.bridged
      .then((bridge) => injectMonaco((asset) => bridge.asset(asset)))
      .then(
        (monaco) => {
          this.install(monaco);
          this.ready = true;
          return monaco;
        },
        (error: unknown) => {
          console.warn("[review-assist] Monaco did not load; showing the built-in renderer", error);
          throw error;
        },
      );
    return this.loading;
  }

  /** Hover, definitions and references for files in `root` until the returned function is called. */
  enableLanguageFeatures(projectId: string, root: string): () => void {
    const holders = (this.featureRoots.get(root)?.holders ?? 0) + 1;
    this.featureRoots.set(root, { projectId, holders });
    return () => {
      const held = this.featureRoots.get(root);
      if (held == null) return;
      if (held.holders > 1) this.featureRoots.set(root, { ...held, holders: held.holders - 1 });
      else this.featureRoots.delete(root);
    };
  }

  applyTheme(monaco: Monaco, theme: PluginTheme, palette: SyntaxPalette): void {
    const key = JSON.stringify([theme.colors, palette]);
    if (key === this.themeKey) return;
    this.themeKey = key;
    monaco.editor.defineTheme(THEME_NAME, monacoTheme(theme, palette));
    monaco.editor.setTheme(THEME_NAME);
  }

  createDiffEditor(monaco: Monaco, container: EditorContainer, options: Readonly<Record<string, unknown>>): DiffEditor {
    const diff = monaco.editor.createDiffEditor(container, options);
    // Re-aims Monaco's global hover-delegate factory, which the diff editor left on its own instantiation
    // service: once that is disposed, lazy widgets in every other editor throw "InstantiationService has been disposed".
    monaco.editor.create(createDetachedNode(), {}).dispose();
    const original = diff.getOriginalEditor();
    original.onDidChangeConfiguration(() => {
      const options = original.getRawOptions();
      // Monaco turns this off for the inline view and keeps it off back side by side (glyph margin on),
      // leaving the old side unwrapped.
      if (options.glyphMargin === true && options.wordWrapOverride2 === "off") original.updateOptions({ wordWrapOverride2: "inherit" });
    });
    return diff;
  }

  /**
   * Shared by every editor showing the same text of this file; pair each call with
   * `releaseModified`. `treeLines` maps each line to the tree's file, null when `text` has its lines.
   */
  acquireModified(
    monaco: Monaco,
    source: CodeSource,
    path: string,
    text: string,
    treeLines: readonly (number | null)[] | null,
  ): MonacoModel {
    const absolute = `${source.root}/${path}`;
    // Keyed by content, so a panel refresh that leaves the file alone keeps its model.
    const uri = monaco.Uri.from({ scheme: "file", path: absolute, query: hashText(text) });
    const key = uri.toString();
    let shared = this.modified.get(key);
    if (shared == null) {
      shared = { model: createModel(monaco, text, uri), treeKeys: new Set(), users: 0 };
      this.modified.set(key, shared);
      this.owners.set(key, { root: source.root, tree: source.tree, path, treeLines });
    }
    shared.users++;
    if (treeLines == null) {
      const treeKey = `${source.tree}\0${absolute}`;
      shared.treeKeys.add(treeKey);
      this.treeModels.set(treeKey, key);
    }
    return shared.model;
  }

  releaseModified(model: MonacoModel): void {
    const key = model.uri.toString();
    const shared = this.modified.get(key);
    if (shared == null || --shared.users > 0) return;
    this.modified.delete(key);
    this.owners.delete(key);
    for (const treeKey of shared.treeKeys) {
      if (this.treeModels.get(treeKey) === key) this.treeModels.delete(treeKey);
    }
    model.dispose();
  }

  /** The caller owns and disposes it. */
  originalModel(monaco: Monaco, path: string, text: string): MonacoModel {
    const uri = monaco.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${this.originals++}/${path}` });
    return createModel(monaco, text, uri);
  }

  dispose(): void {
    for (const registration of this.registrations.splice(0)) registration.dispose();
    this.loading = null;
    this.ready = false;
  }

  private install(monaco: Monaco): void {
    this.registrations.push(
      monaco.languages.registerDefinitionProvider("*", {
        provideDefinition: (model, position) => this.definition(monaco, model, position),
      }),
      monaco.languages.registerReferenceProvider("*", {
        provideReferences: (model, position) => this.references(monaco, model, position),
      }),
      monaco.languages.registerHoverProvider("*", {
        provideHover: (model, position) => this.hover(model, position),
      }),
    );
  }

  private async definition(monaco: Monaco, model: MonacoModel, position: MonacoPosition): Promise<MonacoLocation[] | null> {
    const at = this.treePosition(model, position);
    if (at == null) return null;
    const result = await this.call(at.owner, "textDocument/definition", { position: toLspPosition(at.position) });
    return await this.locations(monaco, model, at.owner, result);
  }

  private async references(monaco: Monaco, model: MonacoModel, position: MonacoPosition): Promise<MonacoLocation[] | null> {
    const at = this.treePosition(model, position);
    if (at == null) return null;
    const result = await this.call(at.owner, "textDocument/references", {
      position: toLspPosition(at.position),
      context: { includeDeclaration: true },
    });
    return await this.locations(monaco, model, at.owner, result, MAX_REFERENCE_MODELS);
  }

  private async hover(model: MonacoModel, position: MonacoPosition): Promise<MonacoHover | null> {
    const at = this.treePosition(model, position);
    if (at == null) return null;
    const hover = toHoverMarkdown(await this.call(at.owner, "textDocument/hover", { position: toLspPosition(at.position) }));
    if (hover == null) return null;
    const range = hover.range == null ? null : fromTree(at.owner, toMonacoRange(hover.range));
    return { contents: [{ value: hover.markdown }], range: range ?? undefined };
  }

  /** Null on a line the tree's file does not have, which no language server has seen. */
  private treePosition(
    model: MonacoModel,
    position: MonacoPosition,
  ): { owner: ModelOwner; position: MonacoPosition } | null {
    const owner = this.owners.get(model.uri.toString());
    if (owner == null) return null;
    const lineNumber = owner.treeLines == null ? position.lineNumber : owner.treeLines[position.lineNumber - 1];
    return lineNumber == null ? null : { owner, position: { lineNumber, column: position.column } };
  }

  private async call(owner: ModelOwner, method: LspMethod, params: Record<string, unknown>): Promise<unknown> {
    const features = this.featureRoots.get(owner.root);
    if (this.bridge == null || features == null) return null;
    const { root, tree, path } = owner;
    try {
      return await this.bridge.lsp({ projectId: features.projectId, root, tree, path, method, params });
    } catch (error) {
      console.warn(`[review-assist] ${method} failed`, error);
      return null;
    }
  }

  /** Peek renders only files that already have a model, so each target gets one first. */
  private async locations(
    monaco: Monaco,
    model: MonacoModel,
    owner: ModelOwner,
    result: unknown,
    limit = Infinity,
  ): Promise<MonacoLocation[]> {
    this.releaseTargets();
    const ownPath = `${owner.root}/${owner.path}`;
    const targets = new Map<string, Promise<MonacoUri | null>>();
    const resolved = await Promise.all(
      toLocations(result)
        .slice(0, limit)
        .map(async (location) => {
          const uri = monaco.Uri.parse(location.uri);
          const range = toMonacoRange(location.range);
          const inModel = uri.path === ownPath ? fromTree(owner, range) : null;
          if (inModel != null) return { uri: model.uri, range: inModel };
          let target = targets.get(location.uri);
          if (target == null) {
            target = this.target(monaco, owner, uri);
            targets.set(location.uri, target);
          }
          const targetUri = await target;
          return targetUri == null ? null : { uri: targetUri, range };
        }),
    );
    return resolved.filter((location) => location != null);
  }

  private async target(monaco: Monaco, owner: ModelOwner, uri: MonacoUri): Promise<MonacoUri | null> {
    // The server answered from the text it was synced at this tree, which may not match the disk.
    const atTree = owner.tree == null ? undefined : this.treeModels.get(`${owner.tree}\0${uri.path}`);
    if (atTree != null) return this.modified.get(atTree)?.model.uri ?? null;
    if (monaco.editor.getModel(uri) != null || this.bridge == null) return uri;
    try {
      const text = await this.bridge.file({ root: owner.root, tree: null, path: uri.path });
      const key = uri.toString();
      if (monaco.editor.getModel(uri) == null) this.targets.set(key, createModel(monaco, text, uri));
      this.owners.set(key, { root: owner.root, tree: null, path: uri.path, treeLines: null });
      return uri;
    } catch (error) {
      console.warn(`[review-assist] could not open ${uri.path}`, error);
      return null;
    }
  }

  /** Reloaded on the next peek rather than kept, so they never drift from the disk. */
  private releaseTargets(): void {
    for (const [key, model] of this.targets) {
      if (model.isAttachedToEditor()) continue;
      this.targets.delete(key);
      this.owners.delete(key);
      model.dispose();
    }
  }
}

function createModel(monaco: Monaco, text: string, uri: MonacoUri): MonacoModel {
  const model = monaco.editor.createModel(text, undefined, uri);
  // Else an editor paints its lines uncoloured, and colours them only frames later.
  model.tokenization.forceTokenization(Math.min(model.getLineCount(), MAX_EAGER_TOKENIZED_LINES));
  return model;
}

/** `range`, given in the tree's file, in the owner's model; null when the model lacks either end. */
function fromTree(owner: ModelOwner, range: MonacoRange): MonacoRange | null {
  if (owner.treeLines == null) return range;
  const start = owner.treeLines.indexOf(range.startLineNumber);
  const end = owner.treeLines.indexOf(range.endLineNumber);
  if (start < 0 || end < 0) return null;
  return { ...range, startLineNumber: start + 1, endLineNumber: end + 1 };
}

export const reviewMonaco = new ReviewMonaco();
