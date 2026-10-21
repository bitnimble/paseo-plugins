import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Image, Text, type TextStyle, View } from "react-native";
import type { DiffFile } from "../shared/diff";
import { messageOf } from "../shared/errors";
import { type BlobPreview, blobRpc } from "../shared/protocol";
import type { CodeSource } from "./monaco/review-monaco";
import { formatBytes } from "./palette";

const MAX_IMAGE_HEIGHT = 480;

type Side = BlobPreview | { readonly status: "loading" };

export function BinaryBody({
  theme,
  file,
  source,
  noteStyle,
}: {
  theme: PluginTheme;
  file: DiffFile;
  source: CodeSource;
  noteStyle: TextStyle;
}) {
  const before = useBlob(source, source.base, file.oldPath, null);
  const after = useBlob(source, source.tree, file.newPath, file.newBlob);
  const sides = [before, after];
  if (sides.some((side) => side?.status === "loading")) {
    return <Text style={noteStyle}>Loading…</Text>;
  }
  if (sides.some((side) => side?.status === "image")) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, padding: 12 }}>
        {before == null ? null : <ImageSide theme={theme} label="Before" side={before} edge={theme.colors.statusDanger} />}
        {after == null ? null : <ImageSide theme={theme} label="After" side={after} edge={theme.colors.statusSuccess} />}
      </View>
    );
  }
  const hiddenText = sides.some((side) => side?.status === "text");
  return (
    <Text style={noteStyle}>
      {hiddenText ? "Diff turned off for this file by .gitattributes." : "Binary file not shown."}
    </Text>
  );
}

function ImageSide({ theme, label, side, edge }: { theme: PluginTheme; label: string; side: Side; edge: string }) {
  const image = side.status === "image" ? side : null;
  const uri = image?.uri ?? null;
  const measured = useImageSize(uri);
  const size = measured === "failed" ? null : measured;
  const muted = { fontSize: 12, color: theme.colors.foregroundMuted };
  const details =
    image == null
      ? "Not shown"
      : [size == null ? null : `${size.width} × ${size.height}`, formatBytes(image.bytes)].filter(Boolean).join(" · ");
  const unavailable = uri == null || measured === "failed";
  return (
    <View style={{ flexGrow: 1, flexBasis: 240, maxWidth: size == null ? undefined : Math.max(size.width, 240), gap: 6 }}>
      <Text style={muted}>
        <Text style={{ color: edge }}>{label}</Text> {details}
      </Text>
      <View style={{ alignSelf: "flex-start", maxWidth: "100%", borderWidth: 1, borderColor: edge, backgroundColor: theme.colors.surface1 }}>
        {unavailable ? (
          <Text style={{ ...muted, padding: 12 }}>Preview unavailable</Text>
        ) : size == null ? (
          <View style={{ width: 240, height: 120 }} />
        ) : (
          <Image
            accessibilityLabel={`${label}: image`}
            source={{ uri }}
            resizeMode="contain"
            style={{
              width: size.width,
              maxWidth: "100%",
              maxHeight: MAX_IMAGE_HEIGHT,
              aspectRatio: size.width / Math.max(size.height, 1),
            }}
          />
        )}
      </View>
    </View>
  );
}

/** Null for a side the file does not have. */
function useBlob(source: CodeSource, tree: string, path: string | null, blob: string | null): Side | null {
  const read = useRpc(blobRpc);
  const query = useQuery({
    queryKey: ["review-blob", source.root, blob ?? tree, path],
    queryFn: () => read({ root: source.root, tree, path: path ?? "", blob }),
    enabled: path != null,
    staleTime: Infinity,
  });
  if (path == null) return null;
  if (query.data != null) return query.data;
  return query.error == null ? { status: "loading" } : { status: "failed", error: messageOf(query.error) };
}

type ImageSize = { width: number; height: number } | "failed";

function useImageSize(uri: string | null): ImageSize | null {
  const [measured, setMeasured] = useState<{ uri: string; size: ImageSize } | null>(null);
  useEffect(() => {
    if (uri == null) return;
    let live = true;
    Image.getSize(
      uri,
      (width, height) => live && setMeasured({ uri, size: { width, height } }),
      () => live && setMeasured({ uri, size: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [uri]);
  return measured != null && measured.uri === uri ? measured.size : null;
}
