import { expect, test } from "@jest/globals";
import { useEffect } from "react";
import { render } from "@testing-library/react-native";
import { useRestoreGate } from "../client/scroll-anchor";

test("the gate keeps a child's restore mark and clears it only when the key changes", () => {
  let gate: ReturnType<typeof useRestoreGate> | undefined;
  function Child({ onReady }: { onReady: () => void }): null {
    useEffect(() => {
      onReady();
    }, []);
    return null;
  }
  function Harness({ k }: { k: string }) {
    gate = useRestoreGate(k);
    return <Child onReady={gate.markRestored} />;
  }

  // The child's onReady effect runs before a parent effect would; the mark must survive the render-time reset.
  const { rerender } = render(<Harness k="a" />);
  expect(gate?.hasRestored()).toBe(true);

  rerender(<Harness k="a" />);
  expect(gate?.hasRestored()).toBe(true);

  rerender(<Harness k="b" />);
  expect(gate?.hasRestored()).toBe(false);
});
