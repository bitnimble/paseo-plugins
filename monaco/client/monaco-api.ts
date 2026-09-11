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
  getValue(): string;
  getWordUntilPosition(position: MonacoPosition): { startColumn: number; endColumn: number };
  onDidChangeContent(listener: () => void): IDisposable;
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

export interface MonacoCompletionItem {
  label: string;
  kind: number;
  insertText: string;
  detail?: string;
  documentation?: { value: string };
  sortText?: string;
  /** Monaco rejects a suggestion without the range its insert text replaces. */
  range: MonacoRange;
}

export interface MonacoCompletionList {
  suggestions: MonacoCompletionItem[];
  incomplete?: boolean;
}

export interface MonacoEditor {
  getModel(): MonacoModel | null;
  setModel(model: MonacoModel | null): void;
  setPosition(position: MonacoPosition): void;
  revealRangeInCenterIfOutsideViewport(range: MonacoRange): void;
  addAction(action: {
    id: string;
    label: string;
    keybindings?: readonly number[];
    run(): void;
  }): IDisposable;
  layout(): void;
  focus(): void;
  dispose(): void;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: readonly { token: string; foreground?: string }[];
  colors: Record<string, string>;
}

export interface MonacoTypeScriptDefaults {
  setModeConfiguration(configuration: Record<string, boolean>): void;
  setDiagnosticsOptions(options: Record<string, boolean>): void;
}

export interface Monaco {
  editor: {
    create(container: EditorContainer, options: Record<string, unknown>): MonacoEditor;
    createModel(value: string, language?: string, uri?: MonacoUri): MonacoModel;
    getModel(uri: MonacoUri): MonacoModel | null;
    defineTheme(name: string, theme: MonacoThemeData): void;
    setTheme(name: string): void;
  };
  languages: {
    registerDefinitionProvider(
      language: string,
      provider: {
        provideDefinition(
          model: MonacoModel,
          position: MonacoPosition,
        ): Promise<MonacoLocation[] | null>;
      },
    ): IDisposable;
    registerReferenceProvider(
      language: string,
      provider: {
        provideReferences(
          model: MonacoModel,
          position: MonacoPosition,
          context: { includeDeclaration: boolean },
        ): Promise<MonacoLocation[] | null>;
      },
    ): IDisposable;
    registerHoverProvider(
      language: string,
      provider: {
        provideHover(model: MonacoModel, position: MonacoPosition): Promise<MonacoHover | null>;
      },
    ): IDisposable;
    registerCompletionItemProvider(
      language: string,
      provider: {
        triggerCharacters?: readonly string[];
        provideCompletionItems(
          model: MonacoModel,
          position: MonacoPosition,
        ): Promise<MonacoCompletionList | null>;
      },
    ): IDisposable;
    typescript?: {
      typescriptDefaults: MonacoTypeScriptDefaults;
      javascriptDefaults: MonacoTypeScriptDefaults;
    };
  };
  Uri: {
    file(path: string): MonacoUri;
    parse(value: string): MonacoUri;
  };
  KeyMod: { readonly CtrlCmd: number };
  KeyCode: { readonly KeyS: number };
}
