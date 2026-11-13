import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import type { PluginTheme } from "@getpaseo/plugin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react-native";
import type { View as HostView } from "react-native";
import { CODE_LINE_HEIGHT, FILE_HEADER_HEIGHT } from "../client/diff-styles";
import { FullView } from "../client/full-view";
import { parseDiff } from "../shared/diff";
import { blockLines, fullBlocks } from "../shared/guide";
import type { ViewOptions } from "../shared/settings";

const mockScrollTo = jest.fn();
jest.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => async () => ({ status: "failed", error: "offline" }),
}));
jest.mock("../shared/protocol", () => ({
  HIGHLIGHT_STYLES: [],
  isDeflated: () => false,
}));
jest.mock("@getpaseo/plugin/client/ui", () => {
  const { createElement, forwardRef, useImperativeHandle, useRef } = jest.requireActual<typeof import("react")>("react");
  const { Text, View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Icon: () => null,
    TextInput: Text,
    ScrollView: forwardRef(function ScrollView(props: { onScroll?: (event: object) => void }, ref) {
      const latest = useRef(props);
      latest.current = props;
      const host = useRef<HostView>(null);
      useImperativeHandle(ref, () =>
        Object.assign(host.current ?? {}, {
          scrollTo: ({ y }: { y: number }) => {
            mockScrollTo(y);
            latest.current.onScroll?.({ nativeEvent: { contentOffset: { y } } });
          },
        }),
      );
      return createElement(View, { ...props, ref: host, testID: "scroll" });
    }),
  };
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
  showPane: false,
  sections: "paged",
};

const added = (path: string, count: number): string[] => [
  `diff --git a/${path} b/${path}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${path}`,
  `@@ -0,0 +1,${count} @@`,
  ...Array.from({ length: count }, (_, i) => `+line ${i}`),
];
const diff = parseDiff([...added("a.ts", 10), ...added("b.ts", 60), ""].join("\n"));
const secondTop = FILE_HEADER_HEIGHT + blockLines(fullBlocks(diff)[0]) * CODE_LINE_HEIGHT;

beforeEach(() => {
  jest.useFakeTimers();
  mockScrollTo.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

function renderWide(onScroll: (anchor: object) => void): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>
      <FullView
        theme={theme}
        narrow={false}
        paneShown={false}
        onCloseDrawer={() => undefined}
        view={view}
        onResizePane={() => undefined}
        fold={null}
        diff={diff}
        source={{ root: "/repo", tree: "tree", base: "base" }}
        scroll={{ path: "b.ts", within: 40 }}
        onScroll={onScroll}
        stateLoaded
        comments={{ comments: [], save: () => undefined, remove: () => undefined }}
      />
    </QueryClientProvider>,
  );
}

test("a wide full diff mounts back at the saved place within its file, and saves where it is scrolled to", () => {
  const onScroll = jest.fn();
  renderWide(onScroll);
  act(() => jest.advanceTimersByTime(3_000));
  expect(mockScrollTo).toHaveBeenLastCalledWith(secondTop + 40);

  act(() => {
    screen.getByTestId("scroll").props.onScroll({ nativeEvent: { contentOffset: { y: secondTop + 90 } } });
    jest.advanceTimersByTime(1_000);
  });
  expect(onScroll).toHaveBeenLastCalledWith({ path: "b.ts", within: 90 });
});
