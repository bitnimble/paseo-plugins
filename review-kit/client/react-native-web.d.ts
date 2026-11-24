import "react-native";

declare module "react-native" {
  interface ViewProps {
    /** react-native-web renders each entry as a `data-*` attribute; ignored on native. */
    dataSet?: Readonly<Record<string, string>>;
  }

  interface ViewStyle {
    /** CSS `touch-action`, which react-native-web passes through; ignored on native. */
    touchAction?: "auto" | "none" | "pan-y";
  }
}
