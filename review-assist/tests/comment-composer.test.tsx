import { expect, jest, test } from "@jest/globals";
import type { PluginTheme } from "@getpaseo/plugin";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { CommentSlot, type FileComments } from "../client/comments";
import { parseDiff } from "../shared/diff";

jest.mock("@getpaseo/plugin/client/ui", () => ({
  Icon: () => null,
  TextInput: jest.requireActual<typeof import("react-native")>("react-native").TextInput,
}));

const theme = {
  colors: { surface0: "#101010", surface1: "#181818", foreground: "#ffffff", foregroundMuted: "#aaaaaa", border: "#333333" },
} as unknown as PluginTheme;

const [file] = parseDiff(
  ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"),
).files;

function renderComposer(): jest.Mock {
  const submit = jest.fn();
  const comments: FileComments = {
    comments: [],
    draft: null,
    compose: () => undefined,
    edit: () => undefined,
    cancel: () => undefined,
    submit,
    remove: () => undefined,
  };
  const lines = file.hunks[0].lines;
  const card = { kind: "new", filePath: "a.ts", blockKey: "0:a.ts", lines, start: 1, end: 1 } as const;
  render(<CommentSlot theme={theme} file={file} card={card} comments={comments} />);
  fireEvent.changeText(screen.getByLabelText("Comment on line 1"), "  looks off ");
  return submit;
}

function pressEnter(modifiers: { ctrlKey?: boolean; metaKey?: boolean }): jest.Mock {
  const preventDefault = jest.fn();
  fireEvent(screen.getByLabelText("Comment on line 1"), "keyPress", {
    nativeEvent: { key: "Enter", ...modifiers },
    preventDefault,
  });
  return preventDefault;
}

test.each([{ ctrlKey: true }, { metaKey: true }])("enter with %o saves the comment", (modifiers) => {
  const submit = renderComposer();
  expect(pressEnter(modifiers)).toHaveBeenCalled();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ side: "new", lineNumber: 1 }), "looks off", null);
});

test("enter alone leaves the comment open", () => {
  const submit = renderComposer();
  expect(pressEnter({})).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
