import { expect, jest, test } from "@jest/globals";
import type { PluginTheme } from "@getpaseo/plugin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { FileComments } from "../client/comments";
import { createStyles } from "../client/diff-styles";
import { NativeBody } from "../client/native-diff";
import { LanguageFeatures } from "../client/peek";
import { ScrollList, type ScrollListHandle } from "../client/windowed-rows";
import { parseDiff } from "../shared/diff";
import { fullBlocks } from "../shared/guide";
import type { PeekOutcome } from "../shared/protocol";
import type { ViewOptions } from "../shared/settings";

const mockPeek = jest.fn(
  async (): Promise<PeekOutcome> => ({
    status: "ok",
    hover: "function greet(name: string): string",
    locations: [
      {
        path: "src/lib.ts",
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
        first: 0,
        lines: ["export function greet(name: string): string {", "  return `hi ${name}`;", "}"],
        tokens: null,
      },
    ],
  }),
);
jest.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) =>
    contract.name === "review.peek" ? mockPeek : async () => ({ status: "unsupported" }),
}));
jest.mock("../shared/protocol", () => ({
  peekRpc: { name: "review.peek" },
  highlightRpc: { name: "review.highlight" },
  fileRpc: { name: "review.file" },
  HIGHLIGHT_STYLES: [],
  isDeflated: () => false,
}));
jest.mock("@getpaseo/plugin/client/ui", () => {
  const { Text, View } = jest.requireActual<typeof import("react-native")>("react-native");
  return { Icon: () => null, Markdown: Text, ScrollView: View, TextInput: Text };
});

const theme = {
  colors: {
    surface0: "#101010",
    surface1: "#181818",
    surface2: "#202020",
    foreground: "#ffffff",
    foregroundMuted: "#aaaaaa",
    border: "#333333",
    accent: "#3794ff",
    statusSuccess: "#00ff00",
    statusDanger: "#ff0000",
  },
} as unknown as PluginTheme;

const view: ViewOptions = {
  layout: "unified",
  wrapLines: true,
  hideWhitespace: false,
  fileList: "flat",
  paneWidth: 300,
  showPane: true,
  sections: "paged",
};

const comments: FileComments = {
  comments: [],
  draft: null,
  compose: () => undefined,
  edit: () => undefined,
  cancel: () => undefined,
  submit: () => undefined,
  remove: () => undefined,
};

const [block] = fullBlocks(
  parseDiff(
    [
      "diff --git a/src/use.ts b/src/use.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/use.ts",
      "@@ -0,0 +1,2 @@",
      '+import { greet } from "./lib";',
      '+export const message = greet("review");',
      "",
    ].join("\n"),
  ),
);

function renderBody(projectId: string | null): void {
  const body = (
    <NativeBody
      block={block}
      source={{ root: "/repo", tree: "tree", base: "base" }}
      view={view}
      styles={createStyles(theme)}
      theme={theme}
      palette={null}
      comments={comments}
      changeLimit={400}
      onShowMore={() => undefined}
      hidden={0}
      text={null}
    />
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>
      <LanguageFeatures.Provider value={projectId == null ? null : { projectId }}>
        <ScrollList
          rows={[{ key: "body", pinned: false, estimate: 0, render: () => body }]}
          handle={createRef<ScrollListHandle>()}
          style={null}
          scrollEnabled
          bottomInset={0}
        />
      </LanguageFeatures.Provider>
    </QueryClientProvider>,
  );
}

test("long-pressing a word peeks at its definition under its line", async () => {
  renderBody("project");
  fireEvent(screen.getAllByText("greet")[1], "longPress");

  expect(await screen.findByText("export function greet(name: string): string {")).toBeTruthy();
  expect(screen.getByText("lib.ts")).toBeTruthy();
  expect(screen.getByText(" src")).toBeTruthy();
  expect(screen.getByText("function greet(name: string): string")).toBeTruthy();
  expect(mockPeek).toHaveBeenCalledWith({
    projectId: "project",
    root: "/repo",
    tree: "tree",
    path: "src/use.ts",
    position: { line: 1, character: 23 },
  });

  fireEvent.press(screen.getByLabelText("Close"));
  expect(screen.queryByText("lib.ts")).toBeNull();
});

test("without a trusted project, words are not pressable", () => {
  renderBody(null);
  expect(screen.getByText('export const message = greet("review");').props.onLongPress).toBeUndefined();
  expect(screen.queryByText("greet")).toBeNull();
});
