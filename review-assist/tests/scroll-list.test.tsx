import { beforeEach, expect, jest, test } from "@jest/globals";
import { createRef } from "react";
import { Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ScrollList, type ScrollListHandle, type WindowedRow } from "../client/windowed-rows";

const mockScrollTo = jest.fn();
jest.mock("@getpaseo/plugin/client/ui", () => {
  const { createElement, forwardRef, useImperativeHandle } = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    ScrollView: forwardRef(function ScrollView(props: object, ref) {
      useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
      return createElement(View, { ...props, testID: "scroll" });
    }),
  };
});

const ROWS: readonly WindowedRow[] = ["a", "b", "c"].map((key) => ({
  key,
  pinned: false,
  estimate: 100,
  render: () => <Text testID={key}>{key}</Text>,
}));

beforeEach(() => {
  mockScrollTo.mockClear();
});

function renderScrolledPastFirstRow(): ScrollListHandle | null {
  const handle = createRef<ScrollListHandle>();
  render(<ScrollList rows={ROWS} handle={handle} style={null} scrollEnabled bottomInset={0} />);
  const scroll = screen.getByTestId("scroll");
  fireEvent(scroll, "layout", { nativeEvent: { layout: { height: 300 } } });
  fireEvent.scroll(scroll, { nativeEvent: { contentOffset: { y: 150 } } });
  return handle.current;
}

function growFirstRow(): void {
  fireEvent(screen.getByTestId("a"), "layout", { nativeEvent: { layout: { width: 320, height: 160 } } });
}

test("a row above the view growing scrolls by as much, keeping what shows in place", () => {
  renderScrolledPastFirstRow();
  growFirstRow();
  expect(mockScrollTo).toHaveBeenCalledWith({ y: 210, animated: false });
});

test("a row above the view growing mid-fling scrolls only once the fling ends", () => {
  renderScrolledPastFirstRow();
  const scroll = screen.getByTestId("scroll");
  fireEvent(scroll, "momentumScrollBegin");
  growFirstRow();
  expect(mockScrollTo).not.toHaveBeenCalled();

  fireEvent.scroll(scroll, { nativeEvent: { contentOffset: { y: 400 } } });
  fireEvent(scroll, "momentumScrollEnd");
  expect(mockScrollTo).toHaveBeenCalledTimes(1);
  expect(mockScrollTo).toHaveBeenCalledWith({ y: 460, animated: false });
});

test("a jump mid-fling lands where asked and ends the fling's hold", () => {
  const handle = renderScrolledPastFirstRow();
  fireEvent(screen.getByTestId("scroll"), "momentumScrollBegin");
  growFirstRow();
  act(() => handle?.scrollTo(250, false));
  expect(mockScrollTo).toHaveBeenLastCalledWith({ y: 250, animated: false });

  fireEvent(screen.getByTestId("a"), "layout", { nativeEvent: { layout: { width: 320, height: 100 } } });
  expect(mockScrollTo).toHaveBeenLastCalledWith({ y: 190, animated: false });
});
