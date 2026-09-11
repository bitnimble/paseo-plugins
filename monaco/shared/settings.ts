import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MONACO_DEFAULT_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/";

export const editorSettings = defineSettings({
  id: "editor",
  scope: "host",
  version: 1,
  schema: z.object({
    fontSize: z.number().int().min(6).max(48).default(13),
    tabSize: z.number().int().min(1).max(16).default(2),
    wordWrap: z.boolean().default(false),
    minimap: z.boolean().default(false),
    lineNumbers: z.boolean().default(true),
    monacoBaseUrl: z.string().default(MONACO_DEFAULT_BASE),
    /** Server id from `server/servers.ts` to a full command line; blank entries use the built-in. */
    languageServers: z.record(z.string(), z.string()).default({}),
  }),
});

export type EditorSettings = z.infer<typeof editorSettings.schema>;

export interface EditorOptions {
  fontSize: number;
  tabSize: number;
  wordWrap: "on" | "off";
  minimap: { enabled: boolean };
  lineNumbers: "on" | "off";
}

export function toEditorOptions(settings: EditorSettings): EditorOptions {
  return {
    fontSize: settings.fontSize,
    tabSize: settings.tabSize,
    wordWrap: settings.wordWrap ? "on" : "off",
    minimap: { enabled: settings.minimap },
    lineNumbers: settings.lineNumbers ? "on" : "off",
  };
}
