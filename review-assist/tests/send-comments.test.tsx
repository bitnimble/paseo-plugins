import { expect, jest, test } from "@jest/globals";
import type { PluginTheme } from "@getpaseo/plugin";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { MessageInput } from "../client/send-comments";

jest.mock("@getpaseo/plugin/client/ui", () => ({ TextInput: jest.requireActual<typeof import("react-native")>("react-native").TextInput }));
jest.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async () => ({}) }));
jest.mock("../shared/protocol", () => ({ agentsRpc: {} }));

const theme = { colors: { foreground: "#fff", foregroundMuted: "#aaa", border: "#333" } } as unknown as PluginTheme;

test("the message updates without waiting for the parent to pass it back", () => {
  const onChange = jest.fn();
  render(<MessageInput theme={theme} initial="draft" onChange={onChange} />);
  const input = screen.getByLabelText("Message to send with the comments");
  expect(input.props.value).toBe("draft");

  fireEvent.changeText(input, "draft speling");

  expect(input.props.value).toBe("draft speling");
  expect(onChange).toHaveBeenCalledWith("draft speling");
});
