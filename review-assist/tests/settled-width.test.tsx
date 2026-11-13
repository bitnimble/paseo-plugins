import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SettledWidth } from "../client/settled-width";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function layOut(width: number): void {
  fireEvent(screen.getByTestId("child"), "layout", { nativeEvent: { layout: { width, height: 600 } } });
}

function laidOutWidth(): unknown {
  const tree = screen.toJSON();
  const inner = tree == null || Array.isArray(tree) ? null : tree.children?.[0];
  return typeof inner === "object" && inner != null ? (inner.props.style as { width?: number }).width : null;
}

test("a single resize, as from showing or hiding the side pane, lays out at the new width at once", () => {
  render(
    <SettledWidth>
      <Text testID="child">diff</Text>
    </SettledWidth>,
  );
  layOut(800);
  act(() => jest.advanceTimersByTime(1_000));
  layOut(1_100);
  expect(laidOutWidth()).toBe(1_100);
});

test("the resizes following it, as from dragging the pane's edge, wait until they pause", () => {
  render(
    <SettledWidth>
      <Text testID="child">diff</Text>
    </SettledWidth>,
  );
  layOut(800);
  act(() => jest.advanceTimersByTime(1_000));
  layOut(790);
  layOut(780);
  layOut(770);
  expect(laidOutWidth()).toBe(790);
  act(() => jest.advanceTimersByTime(1_000));
  expect(laidOutWidth()).toBe(770);
});
