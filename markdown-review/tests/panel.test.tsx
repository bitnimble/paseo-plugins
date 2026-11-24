import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { ZoomableImage } from "../kit/client/zoomable-image";
import {
  HIGHLIGHT_STYLES,
  type MarkdownEntry,
  type MarkdownRun,
  type ReviewState,
  type StateChange,
} from "../kit/shared/protocol";
import { applyStateChange } from "../kit/shared/review-state";
import { MarkdownReviewPanel } from "../client/panel";

const DOCUMENT = "# Plan\n\nShip it.\n\n```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD\n```\n";

const mockState: { current: ReviewState } = { current: { viewed: [], comments: [] } };
const mockChanges: StateChange[] = [];
const mockHandlers: Record<string, (input: never) => Promise<unknown>> = {
  "markdown-review.document": async () => ({ root: "/repo", path: "docs/plan.md" }),
  "review.markdown": async () => ({ status: "ready", entries: ENTRIES }),
  "review.state": async () => mockState.current,
  "review.palette": async () => ({ colors: { keyword: "#c678dd" } }),
  "review.mermaid.draw": async () => ({ status: "ready", uri: "data:image/png;base64,", width: 40, height: 20, truncated: false }),
  "review.state-change": async ({ change }: { change: StateChange }) => {
    mockChanges.push(change);
    mockState.current = applyStateChange(mockState.current, change);
    return mockState.current;
  },
};

jest.mock("@getpaseo/plugin", () => ({ defineRpc: (definition: unknown) => definition }));
jest.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => mockHandlers[contract.name],
  useFileText: () => ({ status: "ready", text: DOCUMENT }),
  usePaseo: () => ({}),
}));
jest.mock("@getpaseo/plugin/client/ui", () => {
  const { ScrollView, Text, TextInput, View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Icon: () => null,
    Loading: () => <Text>Loading</Text>,
    Modal: Object.assign(() => null, { Content: View }),
    ScrollView,
    SettingsCard: View,
    SettingsRow: View,
    SettingsSelect: () => null,
    TextInput,
    useToast: () => ({ error: () => undefined, show: () => undefined }),
  };
});

const ENTRIES: MarkdownEntry[] = [
  entry({ kind: "heading", depth: 1, runs: [run("Plan")] }, 0),
  entry({ kind: "text", runs: [run("Ship it.")] }, 2),
  entry(
    {
      kind: "code",
      language: "ts",
      lines: [{ text: "const a = 1;", change: null, tokens: [5, HIGHLIGHT_STYLES.indexOf("keyword"), 7, -1] }],
    },
    5,
  ),
  entry({ kind: "code", language: "mermaid", lines: [{ text: "graph TD", change: null, tokens: null }] }, 9),
];

const theme = {
  colors: {
    surface0: "#101010",
    surface1: "#181818",
    surface2: "#202020",
    foreground: "#ffffff",
    foregroundMuted: "#aaaaaa",
    border: "#333333",
    accent: "#3366ff",
    accentForeground: "#ffffff",
    statusSuccess: "#00aa00",
    statusDanger: "#aa0000",
    statusWarning: "#aaaa00",
  },
} as unknown as PluginTheme;

function renderPanel(): void {
  const file = { path: "/repo/docs/plan.md", name: "plan.md" };
  const props = { file, theme, workspaceId: "w" } as unknown as PluginFilePanelProps;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } })}>
      <MarkdownReviewPanel {...props} />
    </QueryClientProvider>,
  );
}

test("code blocks are colored by their language, and mermaid blocks drawn as diagrams", async () => {
  renderPanel();

  const diagram = await waitFor(() => screen.UNSAFE_getByType(ZoomableImage));
  const [frame] = diagram.findAll((node: typeof diagram) => typeof node.props.onLayout === "function");
  fireEvent(frame, "layout", { nativeEvent: { layout: { width: 400, height: 300 } } });
  expect(screen.getByLabelText("Diagram")).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByText("const").props.style)?.color).toEqual(expect.any(String));
  expect(StyleSheet.flatten(screen.getByText(" a = 1;").props.style)?.color).toBeUndefined();
});

test("a comment on a block of an unchanged document is saved against the document's line", async () => {
  renderPanel();

  fireEvent.press(await screen.findByText("Ship it."));
  expect(screen.queryByText(/unchanged block/)).toBeNull();
  fireEvent.changeText(screen.getByLabelText("Comment on line 3"), "Say when.");
  fireEvent.press(screen.getByText("Add comment"));

  expect(await screen.findByText("1 comment")).toBeTruthy();
  expect(mockChanges).toEqual([
    {
      kind: "comments",
      remove: [],
      save: [expect.objectContaining({ filePath: "docs/plan.md", side: "new", lineNumber: 3, body: "Say when." })],
    },
  ]);
});

function entry(block: MarkdownEntry["block"], line: number): MarkdownEntry {
  return { change: "same", quote: 0, list: null, block, lines: { side: "new", start: line, end: line } };
}

function run(text: string): MarkdownRun {
  return { text, strong: false, em: false, code: false, strike: false, href: null, image: false, change: null };
}
