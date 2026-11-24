import { Platform } from "react-native";

// The plugins typecheck without the DOM library.
declare const window: { matchMedia?(query: string): { matches: boolean } };

export function hasMouse(): boolean {
  return Platform.OS === "web" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
}
