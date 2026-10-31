import { expect, test } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { useDebouncedCallback } from "../client/scroll-anchor";

test("on native, where there is no document, the debounced call mounts and flushes on unmount", () => {
  const calls: string[] = [];
  let debounced: ((value: string) => void) | undefined;
  function Harness(): null {
    debounced = useDebouncedCallback((value: string) => calls.push(value), 10_000);
    return null;
  }

  const { unmount } = render(<Harness />);
  debounced?.("last");
  expect(calls).toEqual([]);

  unmount();
  expect(calls).toEqual(["last"]);
});
