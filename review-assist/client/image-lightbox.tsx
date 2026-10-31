import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Modal, SafeAreaView, StatusBar, View } from "react-native";
import { ZoomableImage } from "./zoomable-image";

export function ImageLightbox({
  theme,
  uri,
  image,
  label,
  caption,
  onClose,
}: {
  theme: PluginTheme;
  uri: string;
  image: { readonly width: number; readonly height: number };
  label: string;
  caption: ReactNode;
  onClose(): void;
}) {
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, paddingTop: StatusBar.currentHeight ?? 0, backgroundColor: "rgba(0,0,0,0.9)" }}>
        <SafeAreaView style={{ flex: 1 }}>
          <ZoomableImage theme={theme} uri={uri} image={image} label={label} leading={caption} onClose={onClose} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}
