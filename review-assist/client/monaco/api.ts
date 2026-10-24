// The subset of Monaco's API this plugin uses, declared by hand: its own typings need the DOM library.

export interface IDisposable {
  dispose(): void;
}

/** Opaque handle for the DOM node Monaco renders into. */
export interface EditorContainer {
  readonly nodeType: number;
}

export interface MonacoPosition {
  readonly lineNumber: number;
  readonly column: number;
}

export interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoUri {
  readonly path: string;
  toString(): string;
}

export interface MonacoModel {
  readonly uri: MonacoUri;
  isAttachedToEditor(): boolean;
  dispose(): void;
}

export interface MonacoLocation {
  uri: MonacoUri;
  range: MonacoRange;
}

export interface MonacoHover {
  contents: readonly { value: string }[];
  range?: MonacoRange;
}

export interface ViewZone {
  afterLineNumber: number;
  heightInPx: number;
  domNode: EditorContainer;
  ordinal?: number;
  suppressMouseDown?: boolean;
  showInHiddenAreas?: boolean;
  onDomNodeTop?(top: number): void;
}

export interface ViewZoneAccessor {
  addZone(zone: ViewZone): string;
  removeZone(id: string): void;
  layoutZone(id: string): void;
}

export interface EditorMouseEvent {
  readonly target: { readonly type: number; readonly position: MonacoPosition | null };
}

export interface Decoration {
  range: MonacoRange;
  options: {
    isWholeLine?: boolean;
    className?: string;
    marginClassName?: string;
    glyphMarginClassName?: string;
    firstLineDecorationClassName?: string;
  };
}

/** An end line of 0 means the change has no lines on that side. */
export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

export interface DecorationsCollection {
  set(decorations: readonly Decoration[]): void;
  clear(): void;
}

export interface CodeEditor {
  setModel(model: MonacoModel | null): void;
  getContentHeight(): number;
  getSelection(): MonacoRange | null;
  onDidContentSizeChange(listener: () => void): IDisposable;
  onMouseMove(listener: (event: EditorMouseEvent) => void): IDisposable;
  onMouseLeave(listener: () => void): IDisposable;
  onMouseDown(listener: (event: EditorMouseEvent) => void): IDisposable;
  changeViewZones(callback: (accessor: ViewZoneAccessor) => void): void;
  createDecorationsCollection(decorations?: readonly Decoration[]): DecorationsCollection;
  updateOptions(options: Readonly<Record<string, unknown>>): void;
  dispose(): void;
}

export interface DiffEditor {
  setModel(model: { original: MonacoModel; modified: MonacoModel } | null): void;
  getOriginalEditor(): CodeEditor;
  getModifiedEditor(): CodeEditor;
  getLineChanges(): readonly LineChange[] | null;
  onDidUpdateDiff(listener: () => void): IDisposable;
  updateOptions(options: Readonly<Record<string, unknown>>): void;
  dispose(): void;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: readonly { token: string; foreground?: string; fontStyle?: string }[];
  colors: Readonly<Record<string, string>>;
}

type Provider<Result> = (model: MonacoModel, position: MonacoPosition) => Promise<Result | null>;

export interface Monaco {
  editor: {
    create(container: EditorContainer, options: Readonly<Record<string, unknown>>): CodeEditor;
    createDiffEditor(container: EditorContainer, options: Readonly<Record<string, unknown>>): DiffEditor;
    createModel(value: string, language: string | undefined, uri: MonacoUri): MonacoModel;
    getModel(uri: MonacoUri): MonacoModel | null;
    defineTheme(name: string, theme: MonacoThemeData): void;
    setTheme(name: string): void;
    MouseTargetType: { readonly GUTTER_GLYPH_MARGIN: number };
  };
  languages: {
    registerDefinitionProvider(selector: string, provider: { provideDefinition: Provider<MonacoLocation[]> }): IDisposable;
    registerReferenceProvider(selector: string, provider: { provideReferences: Provider<MonacoLocation[]> }): IDisposable;
    registerHoverProvider(selector: string, provider: { provideHover: Provider<MonacoHover> }): IDisposable;
  };
  Uri: {
    parse(value: string): MonacoUri;
    from(components: { scheme: string; path: string; query?: string }): MonacoUri;
  };
}
