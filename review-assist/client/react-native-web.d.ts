import "react-native";

declare module "react-native" {
  interface ViewProps {
    /** react-native-web renders each entry as a `data-*` attribute; ignored on native. */
    dataSet?: Readonly<Record<string, string>>;
  }
}
