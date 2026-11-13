import { expect, test } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { useDebouncedCallback } from "../client/scroll-anchor";

test("on native, where there is no document, the debounced call mounts and flushes on unmount", () => {
  const calls: string[] = [];
  let debounced: ((value: string) => void) | undefined;
  function Harness(): null {
    debounced = useDebouncedCallback((value: string) => calls.push(value), 10_000, "list");
    return null;
  }

  const { unmount } = render(<Harness />);
  debounced?.("last");
  expect(calls).toEqual([]);

  unmount();
  expect(calls).toEqual(["last"]);
});

test("a call still pending when its key changes is dropped, not made about the new key", () => {
  const calls: string[] = [];
  let debounced: ((value: string) => void) | undefined;
  function Harness({ listKey }: { listKey: string }): null {
    debounced = useDebouncedCallback((value: string) => calls.push(value), 10_000, listKey);
    return null;
  }

  const { rerender, unmount } = render(<Harness listKey="section 1" />);
  debounced?.("scrolled in section 1");
  rerender(<Harness listKey="section 2" />);
  unmount();
  expect(calls).toEqual([]);
});
