import { beforeEach, expect, jest, test } from "@jest/globals";
import type { PluginTheme } from "@getpaseo/plugin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Image } from "react-native";
import { BinaryBody } from "../client/binary-view";
import type { CodeSource } from "../client/monaco/review-monaco";
import { ZoomableImage } from "../client/zoomable-image";
import type { DiffFile } from "../shared/diff";

jest.mock("@getpaseo/plugin/client/ui", () => ({ Icon: () => null }));
jest.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => async (input: { path: string }) => ({ status: "image", uri: `data:${input.path}`, bytes: 2048 }),
}));
jest.mock("../shared/protocol", () => ({ blobRpc: {} }));

const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#aaa",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    statusDanger: "#f00",
    statusSuccess: "#0f0",
  },
} as unknown as PluginTheme;

const noop = (): void => undefined;

beforeEach(() => {
  jest.spyOn(Image, "getSize").mockImplementation((_uri, onSuccess) => {
    onSuccess(1600, 1200);
    return Promise.resolve({ width: 1600, height: 1200 });
  });
});

function touchEvent(x: number, y: number, timestamp: number, previousX = x, fingers = 1): unknown {
  const touch = { locationX: x, locationY: y, pageX: x, pageY: y };
  return {
    nativeEvent: { touches: Array.from({ length: fingers }, (_, index) => ({ ...touch, pageX: x + index * 50 })) },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: timestamp,
      touchBank: [
        {
          touchActive: true,
          startPageX: x,
          startPageY: y,
          startTimeStamp: 0,
          currentPageX: x,
          currentPageY: y,
          currentTimeStamp: timestamp,
          previousPageX: previousX,
          previousPageY: y,
          previousTimeStamp: 0,
        },
      ],
    },
  };
}

function renderFilling(onClose: () => void): void {
  render(<ZoomableImage theme={theme} uri="data:image" image={{ width: 400, height: 1200 }} label="Shot" onClose={onClose} />);
  fireEvent(screen.root, "layout", { nativeEvent: { layout: { width: 800, height: 600 } } });
}

function press(x: number, y: number): void {
  const frame = screen.getByLabelText("Shot");
  expect(frame.props.onStartShouldSetResponder(touchEvent(x, y, 1))).toBe(true);
  frame.props.onResponderGrant(touchEvent(x, y, 1));
  frame.props.onResponderRelease(touchEvent(x, y, 1));
}

test("filling a parent fits a tall image to the height, not just the width", () => {
  renderFilling(noop);
  expect(screen.getByText("50%")).toBeTruthy();
});

test("a press beside the image closes and a press on it does not", () => {
  const onClose = jest.fn(noop);
  renderFilling(onClose);

  press(400, 300);
  expect(onClose).toHaveBeenCalledTimes(0);

  press(100, 300);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a drag starting beside the image does not close", () => {
  const onClose = jest.fn(noop);
  renderFilling(onClose);
  const frame = screen.getByLabelText("Shot");

  frame.props.onResponderGrant(touchEvent(100, 300, 1));
  frame.props.onResponderMove(touchEvent(160, 300, 2, 100));
  frame.props.onResponderRelease(touchEvent(160, 300, 2));

  expect(onClose).toHaveBeenCalledTimes(0);
});

test("a pinch that ends on one finger beside the image does not close", () => {
  const onClose = jest.fn(noop);
  renderFilling(onClose);
  const frame = screen.getByLabelText("Shot");

  frame.props.onResponderGrant(touchEvent(100, 300, 1));
  frame.props.onResponderMove(touchEvent(100, 300, 2, 100, 2));
  frame.props.onResponderMove(touchEvent(100, 300, 3));
  frame.props.onResponderRelease(touchEvent(100, 300, 3));

  expect(onClose).toHaveBeenCalledTimes(0);
});

test("without onClose it fits to the width alone, leaves touches to the list and has no close button", () => {
  render(<ZoomableImage theme={theme} uri="data:image" image={{ width: 400, height: 1200 }} label="Shot" />);
  fireEvent(screen.root, "layout", { nativeEvent: { layout: { width: 800, height: 600 } } });

  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.queryByLabelText("Close")).toBeNull();
  expect(screen.getByLabelText("Shot").props.onStartShouldSetResponder(touchEvent(100, 300, 1))).toBe(false);
});

test.each(["Before", "After"])("pressing the %s image opens it full size until closed", async (side) => {
  const file = { oldPath: "old.png", newPath: "new.png", newBlob: "blob" } as DiffFile;
  const source = { root: "/repo", base: "base", tree: "tree" } as CodeSource;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })}>
      <BinaryBody theme={theme} file={file} source={source} noteStyle={{}} />
    </QueryClientProvider>,
  );

  fireEvent.press(await screen.findByLabelText(`${side}: view full size`));
  const [measured] = screen
    .UNSAFE_getByType(ZoomableImage)
    .findAll((node: { props: { onLayout?: unknown } }) => node.props.onLayout != null);
  fireEvent(measured, "layout", { nativeEvent: { layout: { width: 800, height: 600 } } });
  expect(screen.getByLabelText(`${side}: image`)).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Close"));
  expect(screen.queryByLabelText(`${side}: image`)).toBeNull();
});
