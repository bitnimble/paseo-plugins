import type { PluginTheme } from "@getpaseo/plugin";
import { LSP_MONACO_LANGUAGES, languageForPath } from "../shared/languages";
import type { LspMethod } from "../shared/protocol";
import { toEditorOptions, type EditorSettings } from "../shared/settings";
import {
  toCompletions,
  toHoverMarkdown,
  toLocations,
  toLspPosition,
  toMonacoRange,
} from "./convert";
import type {
  EditorContainer,
  IDisposable,
  Monaco,
  MonacoCompletionList,
  MonacoEditor,
  MonacoHover,
  MonacoLocation,
  MonacoModel,
  MonacoPosition,
  MonacoRange,
  MonacoUri,
} from "./monaco-api";
import { loadMonaco } from "./web";

export interface EditorBridge {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  request(path: string, method: LspMethod, params: Record<string, unknown>): Promise<unknown>;
  sync(path: string, kind: "change" | "save" | "close", text: string): void;
  openPath(path: string): void;
  reportError(message: string): void;
}

interface EditorWithCodeService {
  _codeEditorService: {
    openCodeEditor(
      input: { resource: MonacoUri; options?: { selection?: MonacoRange } },
      source: MonacoEditor,
    ): Promise<MonacoEditor | null>;
  };
}

// A definition can land outside the workspace, most often in a dependency's .d.ts.
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\/)/;
const CHANGE_DEBOUNCE_MS = 250;
const MAX_PEEK_MODELS = 40;
const TRIGGER_CHARACTERS = [".", ":", "<", '"', "'", "/", "@", "#", " "];

const controllers = new Set<EditorController>();
let providerRegistrations: IDisposable[] | null = null;
let openCodeEditorPatched = false;

/** Monaco outlives a plugin reload; without this the previous bundle's providers keep answering. */
export function disposeProviders(): void {
  for (const registration of providerRegistrations ?? []) {
    registration.dispose();
  }
  providerRegistrations = null;
  openCodeEditorPatched = false;
}

export class EditorController {
  private readonly models = new Map<string, MonacoModel>();
  private readonly opened = new Set<string>();
  private readonly disposables: IDisposable[] = [];
  private readonly pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(
    private readonly monaco: Monaco,
    private readonly editor: MonacoEditor,
    private readonly directory: string,
    private readonly bridge: EditorBridge,
  ) {}

  static async create(
    container: EditorContainer,
    directory: string,
    bridge: EditorBridge,
    theme: PluginTheme,
    settings: EditorSettings,
  ): Promise<EditorController> {
    const monaco = await loadMonaco(settings.monacoBaseUrl);
    applyTheme(monaco, theme);
    registerProviders(monaco);

    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      scrollBeyondLastLine: false,
      theme: "paseo",
      ...toEditorOptions(settings),
    });
    const controller = new EditorController(monaco, editor, directory, bridge);
    controllers.add(controller);
    patchOpenCodeEditor(editor);

    editor.addAction({
      id: "paseo.save",
      label: "Save",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => void controller.save(),
    });

    return controller;
  }

  async open(resource: MonacoUri, selection: MonacoRange | undefined): Promise<MonacoEditor> {
    const path = this.pathFor(resource.path);
    this.bridge.openPath(path);
    await this.show(path);
    if (selection != null) {
      this.reveal(selection);
    }
    return this.editor;
  }

  async show(path: string): Promise<void> {
    const model = await this.modelFor(path);
    this.opened.add(path);
    if (this.editor.getModel() !== model) {
      this.editor.setModel(model);
    }
    this.editor.focus();
  }

  closed(path: string): void {
    this.opened.delete(path);
    if (this.release(path)) {
      this.bridge.sync(path, "close", "");
    }
  }

  setTheme(theme: PluginTheme): void {
    applyTheme(this.monaco, theme);
  }

  setOptions(settings: EditorSettings): void {
    this.editor.updateOptions(toEditorOptions(settings));
  }

  dispose(): void {
    controllers.delete(this);
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.editor.setModel(null);
    for (const model of this.models.values()) {
      model.dispose();
    }
    this.models.clear();
    this.opened.clear();
    this.editor.dispose();
  }

  /** Also claims files opened from a definition outside the workspace, such as a dependency's .d.ts. */
  owns(uri: MonacoUri): boolean {
    return uri.path.startsWith(`${this.directory}/`) || this.models.has(this.pathFor(uri.path));
  }

  async definition(model: MonacoModel, position: MonacoPosition): Promise<MonacoLocation[] | null> {
    const result = await this.call(model, "textDocument/definition", {
      position: toLspPosition(position),
    });
    return this.locationsFrom(result);
  }

  async references(model: MonacoModel, position: MonacoPosition): Promise<MonacoLocation[] | null> {
    const result = await this.call(model, "textDocument/references", {
      position: toLspPosition(position),
      context: { includeDeclaration: true },
    });
    const locations = toLocations(result).slice(0, MAX_PEEK_MODELS);
    this.releasePreviews();
    // The peek widget renders a preview per result, and only for files that already have a model.
    // One unreadable file costs that row its preview, never the rest of the list.
    await Promise.all(
      locations.map(async (location) => {
        await this.modelFor(this.pathFor(location.uri)).catch(() => null);
      }),
    );
    return this.locationsFrom(locations);
  }

  async hover(model: MonacoModel, position: MonacoPosition): Promise<MonacoHover | null> {
    const result = await this.call(model, "textDocument/hover", {
      position: toLspPosition(position),
    });
    const hover = toHoverMarkdown(result);
    if (hover == null) {
      return null;
    }
    return {
      contents: [{ value: hover.markdown }],
      range: hover.range == null ? undefined : toMonacoRange(hover.range),
    };
  }

  async completions(
    model: MonacoModel,
    position: MonacoPosition,
  ): Promise<MonacoCompletionList | null> {
    const result = await this.call(model, "textDocument/completion", {
      position: toLspPosition(position),
    });
    const word = model.getWordUntilPosition(position);
    // ponytail: the current word, not each item's own textEdit range. Server-driven ranges matter
    // for completions that rewrite more than the prefix, such as auto-import specifiers.
    const range = {
      startLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn,
    };
    return {
      suggestions: toCompletions(result).map(({ documentation, ...item }) => ({
        ...item,
        range,
        documentation: documentation == null ? undefined : { value: documentation },
      })),
    };
  }

  private async save(): Promise<void> {
    const model = this.editor.getModel();
    if (model == null) {
      return;
    }
    const path = this.pathFor(model.uri.path);
    const text = model.getValue();
    try {
      await this.bridge.writeFile(path, text);
      this.bridge.sync(path, "save", text);
    } catch (error) {
      this.bridge.reportError(error instanceof Error ? error.message : String(error));
    }
  }

  private reveal(range: MonacoRange): void {
    this.editor.revealRangeInCenterIfOutsideViewport(range);
    this.editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
  }

  private async call(
    model: MonacoModel,
    method: LspMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.bridge.request(this.pathFor(model.uri.path), method, params);
  }

  /** Peek previews need a model per result, and nothing else ever closes those files. */
  private releasePreviews(): void {
    for (const path of [...this.models.keys()]) {
      if (!this.opened.has(path)) {
        this.release(path);
      }
    }
  }

  private release(path: string): boolean {
    const model = this.models.get(path);
    if (model == null) {
      return false;
    }
    clearTimeout(this.pendingChanges.get(path));
    this.pendingChanges.delete(path);
    this.models.delete(path);
    // Monaco keeps rendering a disposed model if it is still attached, with no way back.
    if (this.editor.getModel() === model) {
      this.editor.setModel(null);
    }
    model.dispose();
    return true;
  }

  private async modelFor(path: string): Promise<MonacoModel> {
    const existing = this.models.get(path);
    if (existing != null) {
      return existing;
    }
    const uri = this.monaco.Uri.file(this.absolutePath(path));
    const text = await this.bridge.readFile(path);
    const model =
      this.monaco.editor.getModel(uri) ??
      this.monaco.editor.createModel(text, languageForPath(path)?.monacoLanguage, uri);
    this.models.set(path, model);
    this.disposables.push(model.onDidChangeContent(() => this.queueChange(path, model)));
    return model;
  }

  private queueChange(path: string, model: MonacoModel): void {
    clearTimeout(this.pendingChanges.get(path));
    const timer = setTimeout(() => {
      this.pendingChanges.delete(path);
      this.bridge.sync(path, "change", model.getValue());
    }, CHANGE_DEBOUNCE_MS);
    this.pendingChanges.set(path, timer);
  }

  private absolutePath(path: string): string {
    return ABSOLUTE_PATH.test(path) ? path : `${this.directory}/${path}`;
  }

  private pathFor(uriOrPath: string): string {
    const path = uriOrPath.startsWith("file://")
      ? decodeURIComponent(uriOrPath.slice("file://".length))
      : uriOrPath;
    return path.startsWith(`${this.directory}/`) ? path.slice(this.directory.length + 1) : path;
  }

  private locationsFrom(result: unknown): MonacoLocation[] {
    return toLocations(result).map((location) => ({
      uri: this.monaco.Uri.file(this.absolutePath(this.pathFor(location.uri))),
      range: toMonacoRange(location.range),
    }));
  }
}

function controllerFor(uri: MonacoUri): EditorController | null {
  for (const controller of controllers) {
    if (controller.owns(uri)) {
      return controller;
    }
  }
  return null;
}

/**
 * Go to definition and the reference peek both open files through this service, and refusing to
 * answer leaves Monaco stuck in the current model. The service is shared by every standalone editor
 * on the page, so the override dispatches on the requested file rather than closing over one panel.
 */
function patchOpenCodeEditor(editor: MonacoEditor): void {
  if (openCodeEditorPatched) {
    return;
  }
  openCodeEditorPatched = true;
  const internals = editor as unknown as EditorWithCodeService;
  internals._codeEditorService.openCodeEditor = async (input, source) =>
    (await controllerFor(input.resource)?.open(input.resource, input.options?.selection)) ?? source;
}

function registerProviders(monaco: Monaco): void {
  if (providerRegistrations != null) {
    return;
  }

  // Monaco's bundled TypeScript worker answers the same requests from a project it cannot see.
  const typescript = monaco.languages.typescript;
  if (typescript != null) {
    const off = { completionItems: false, hovers: false, definitions: false, references: false };
    typescript.typescriptDefaults.setModeConfiguration(off);
    typescript.javascriptDefaults.setModeConfiguration(off);
  }

  providerRegistrations = LSP_MONACO_LANGUAGES.flatMap((language) => [
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) =>
        (await controllerFor(model.uri)?.definition(model, position)) ?? null,
    }),
    monaco.languages.registerReferenceProvider(language, {
      provideReferences: async (model, position) =>
        (await controllerFor(model.uri)?.references(model, position)) ?? null,
    }),
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) =>
        (await controllerFor(model.uri)?.hover(model, position)) ?? null,
    }),
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: TRIGGER_CHARACTERS,
      provideCompletionItems: async (model, position) =>
        (await controllerFor(model.uri)?.completions(model, position)) ?? null,
    }),
  ]);
}

function applyTheme(monaco: Monaco, theme: PluginTheme): void {
  monaco.editor.defineTheme("paseo", {
    base: isDark(theme.colors.surface0) ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": theme.colors.surface0,
      "editor.foreground": theme.colors.foreground,
      "editorLineNumber.foreground": theme.colors.foregroundMuted,
    },
  });
  monaco.editor.setTheme("paseo");
}

function isDark(color: string): boolean {
  const hex = color.replace("#", "");
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : hex;
  const value = Number.parseInt(expanded.slice(0, 6), 16);
  if (!Number.isFinite(value)) {
    return true;
  }
  const [red, green, blue] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return 0.299 * red + 0.587 * green + 0.114 * blue < 128;
}
