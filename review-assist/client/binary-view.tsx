import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Image, Pressable, Text, type TextStyle, View } from "react-native";
import type { DiffFile } from "../shared/diff";
import { messageOf } from "../shared/errors";
import { type BlobPreview, blobRpc } from "../shared/protocol";
import { Button } from "./controls";
import { ImageLightbox } from "./image-lightbox";
import type { CodeSource } from "./monaco/review-monaco";
import { formatBytes } from "./palette";

const MAX_IMAGE_HEIGHT = 480;

/** `idle` until an LFS file's content is asked for. */
type Side = BlobPreview | { readonly status: "loading" } | { readonly status: "idle" };

interface BodyProps {
  theme: PluginTheme;
  file: DiffFile;
  source: CodeSource;
  noteStyle: TextStyle;
}

export function BinaryBody({ theme, file, source, noteStyle }: BodyProps) {
  const before = useBlob(source, source.base, file.oldPath, null, { lfs: false, enabled: true });
  const after = useBlob(source, source.tree, file.newPath, file.newBlob, { lfs: false, enabled: true });
  return (
    <Comparison
      theme={theme}
      before={before}
      after={after}
      noteStyle={noteStyle}
      loading="Loading…"
      text="Diff turned off for this file by .gitattributes."
    />
  );
}

export function LfsBody({ theme, file, source, noteStyle }: BodyProps) {
  const [requested, setRequested] = useState(false);
  const before = useBlob(source, source.base, file.oldPath, null, { lfs: true, enabled: requested });
  const after = useBlob(source, source.tree, file.newPath, file.newBlob, { lfs: true, enabled: requested });
  if ([before, after].some((side) => side?.status === "idle")) {
    return (
      <View style={{ paddingBottom: 12 }}>
        <Text style={noteStyle}>Stored in Git LFS, so the diff only changes its pointer.</Text>
        <View style={{ paddingHorizontal: 12, alignItems: "flex-start" }}>
          <Button theme={theme} label="Fetch and compare" icon="Download" size="xs" onPress={() => setRequested(true)} />
        </View>
      </View>
    );
  }
  return (
    <Comparison
      theme={theme}
      before={before}
      after={after}
      noteStyle={noteStyle}
      loading="Fetching from Git LFS…"
      text="Text stored in Git LFS isn't compared here."
    />
  );
}

/** `loading` and `text` are the notes shown while the sides load and when they turn out to be text. */
function Comparison({
  theme,
  before,
  after,
  noteStyle,
  loading,
  text,
}: {
  theme: PluginTheme;
  before: Side | null;
  after: Side | null;
  noteStyle: TextStyle;
  loading: string;
  text: string;
}) {
  const sides = [before, after];
  if (sides.some((side) => side?.status === "loading")) {
    return <Text style={noteStyle}>{loading}</Text>;
  }
  if (sides.some((side) => side?.status === "image")) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 16, padding: 12 }}>
        {before == null ? null : <ImageSide theme={theme} label="Before" side={before} edge={theme.colors.statusDanger} />}
        {after == null ? null : <ImageSide theme={theme} label="After" side={after} edge={theme.colors.statusSuccess} />}
      </View>
    );
  }
  const failed = sides.find((side) => side?.status === "failed");
  if (failed?.status === "failed") return <Text style={noteStyle}>{failed.error}</Text>;
  const hiddenText = sides.some((side) => side?.status === "text");
  return <Text style={noteStyle}>{hiddenText ? text : "Binary file not shown."}</Text>;
}

function ImageSide({ theme, label, side, edge }: { theme: PluginTheme; label: string; side: Side; edge: string }) {
  const [enlarged, setEnlarged] = useState(false);
  const image = side.status === "image" ? side : null;
  const uri = image?.uri ?? null;
  const measured = useImageSize(uri);
  const size = measured === "failed" ? null : measured;
  const muted = { fontSize: 12, color: theme.colors.foregroundMuted };
  const details =
    image == null
      ? "Not shown"
      : [size == null ? null : `${size.width} × ${size.height}`, formatBytes(image.bytes)].filter(Boolean).join(" · ");
  const empty = size != null && (size.width === 0 || size.height === 0);
  const unavailable = uri == null || measured === "failed" || empty;
  const fit =
    size == null || empty
      ? null
      : { width: Math.min(size.width, (MAX_IMAGE_HEIGHT * size.width) / size.height), aspectRatio: size.width / size.height };
  const caption = (
    <Text style={{ ...muted, flexShrink: 1 }}>
      <Text style={{ color: edge }}>{label}</Text> {details}
    </Text>
  );
  return (
    <View style={{ flexGrow: 1, flexBasis: 240, maxWidth: fit == null ? undefined : Math.max(fit.width, 240), alignItems: "center", gap: 6 }}>
      {caption}
      <View style={{ maxWidth: "100%", borderWidth: 1, borderColor: edge, backgroundColor: theme.colors.surface1 }}>
        {unavailable ? (
          <Text style={{ ...muted, padding: 12 }}>Preview unavailable</Text>
        ) : fit == null ? (
          <View style={{ width: 240, height: 120 }} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label}: view full size`}
            onPress={() => setEnlarged(true)}
            style={{ maxWidth: "100%" }}
          >
            <Image source={{ uri }} resizeMode="contain" style={{ ...fit, maxWidth: "100%" }} />
          </Pressable>
        )}
      </View>
      {enlarged && !unavailable && size != null ? (
        <ImageLightbox
          theme={theme}
          uri={uri}
          image={size}
          label={`${label}: image`}
          caption={caption}
          onClose={() => setEnlarged(false)}
        />
      ) : null}
    </View>
  );
}

/** Null for a side the file does not have. */
function useBlob(
  source: CodeSource,
  tree: string,
  path: string | null,
  blob: string | null,
  { lfs, enabled }: { lfs: boolean; enabled: boolean },
): Side | null {
  const read = useRpc(blobRpc);
  const query = useQuery({
    queryKey: ["review-blob", source.root, blob ?? tree, path, lfs],
    queryFn: () => read({ root: source.root, tree, path: path ?? "", blob, lfs }),
    enabled: path != null && enabled,
    staleTime: Infinity,
  });
  if (path == null) return null;
  if (query.data != null) return query.data;
  if (query.error != null) return { status: "failed", error: messageOf(query.error) };
  return enabled ? { status: "loading" } : { status: "idle" };
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
