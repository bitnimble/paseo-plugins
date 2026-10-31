import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type GestureResponderEvent, Image, type NativeTouchEvent, PanResponder, Text, View } from "react-native";
import { IconButton } from "./controls";

const MAX_SCALE = 3;
const MAX_FRAME_HEIGHT = 480;
const STEP = 1.5;
const FIT_SLACK = 1.01;
const TAP_SLOP = 8;

export const ScrollLock = createContext<(locked: boolean) => void>(() => undefined);

interface Size {
  readonly width: number;
  readonly height: number;
}

/** A null height lets the frame grow with the zoom, up to `MAX_FRAME_HEIGHT`. */
interface Room {
  readonly width: number;
  readonly height: number | null;
}

interface Frame extends Size {
  readonly fit: number;
}

interface Camera {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Gesture {
  readonly base: Camera;
  readonly touches: number;
  /** One finger from the start, so its release can count as a press. */
  readonly press: boolean;
  readonly spread: number;
  readonly centre: Point;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Fitted to the width it is given, at a fixed height. Pinch or the buttons zoom; dragging pans only
 * while zoomed, so the list scrolls past it otherwise.
 */
export function ZoomableImage({
  theme,
  uri,
  image,
  label,
  leading,
  onClose,
}: {
  theme: PluginTheme;
  uri: string;
  image: Size;
  label: string;
  leading?: ReactNode;
  /** Makes it fill its parent, fitted both ways, with a close button; a press beside the image closes too. */
  onClose?: () => void;
}) {
  const lock = useContext(ScrollLock);
  const [measured, setMeasured] = useState<Room | null>(null);
  const [zoom, setZoom] = useState<{ uri: string; camera: Camera } | null>(null);
  const room = measured ?? { width: image.width, height: null };
  const fit = fitFor(image, room);
  const zoomed = zoom?.uri === uri && zoom.camera.scale > fit * FIT_SLACK ? zoom.camera : null;
  const frame = frameFor(image, room, zoomed?.scale ?? fit);
  const camera = place(zoomed ?? { scale: fit, x: 0, y: 0 }, image, frame);
  const latest = useRef({ uri, image, room, frame, camera, onClose });
  latest.current = { uri, image, room, frame, camera, onClose };
  const gesture = useRef<Gesture | null>(null);
  const setZoomed = (zoomedCamera: Camera | null) =>
    setZoom(zoomedCamera == null ? null : { uri: latest.current.uri, camera: zoomedCamera });

  useEffect(() => () => lock(false), [lock]);

  const responder = useMemo(() => {
    const begin = (event: GestureResponderEvent, dx: number, dy: number) => {
      const touches = event.nativeEvent.touches;
      gesture.current = {
        base: latest.current.camera,
        touches: touches.length,
        press: gesture.current == null && touches.length === 1,
        spread: spreadOf(touches),
        centre: centreOf(touches),
        dx,
        dy,
      };
    };
    const end = () => {
      gesture.current = null;
      lock(false);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length >= 2 || latest.current.onClose != null,
      onMoveShouldSetPanResponder: (event, { dx, dy }) =>
        event.nativeEvent.touches.length >= 2 ||
        (latest.current.camera.scale > latest.current.frame.fit && Math.abs(dx) + Math.abs(dy) > 2),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event, { dx, dy }) => {
        lock(true);
        begin(event, dx, dy);
      },
      onPanResponderMove: (event, { dx, dy }) => {
        const touches = event.nativeEvent.touches;
        if (touches.length !== gesture.current?.touches) begin(event, dx, dy);
        const current = gesture.current;
        if (current == null) return;
        const moved =
          touches.length >= 2
            ? pinch(current, spreadOf(touches), centreOf(touches))
            : { ...current.base, x: current.base.x + dx - current.dx, y: current.base.y + dy - current.dy };
        setZoomed(settle(moved, latest.current.image, latest.current.room));
      },
      onPanResponderRelease: (_, { dx, dy }) => {
        const pressed = gesture.current;
        end();
        const { onClose: close, camera: placed, image: drawn } = latest.current;
        if (close == null || pressed?.press !== true || Math.abs(dx) + Math.abs(dy) > TAP_SLOP) return;
        if (!isOnImage(pressed.centre, placed, drawn)) close();
      },
      onPanResponderTerminate: end,
    });
  }, [lock]);

  const step = (factor: number) =>
    setZoomed(settle(zoomAround(camera, camera.scale * factor, { x: frame.width / 2, y: frame.height / 2 }), image, room));

  return (
    <View
      style={onClose == null ? undefined : { flex: 1 }}
      onLayout={({ nativeEvent: { layout } }) => {
        const { width } = layout;
        const height = onClose == null ? null : layout.height;
        setMeasured((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
      }}
    >
      {measured == null ? null : (
        <>
          <View
            style={[
              { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
              onClose == null
                ? { marginBottom: 6 }
                : {
                    position: "absolute",
                    top: 8,
                    left: 8,
                    right: 8,
                    zIndex: 1,
                    paddingLeft: 10,
                    gap: 8,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface0,
                  },
            ]}
          >
            {leading ?? <View />}
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <IconButton
                theme={theme}
                icon="ZoomOut"
                label="Zoom out"
                disabled={zoomed == null}
                onPress={() => step(1 / STEP)}
              />
              <Text style={{ minWidth: 40, textAlign: "center", fontSize: 12, color: theme.colors.foregroundMuted }}>
                {Math.round(camera.scale * 100)}%
              </Text>
              <IconButton
                theme={theme}
                icon="ZoomIn"
                label="Zoom in"
                disabled={camera.scale >= MAX_SCALE}
                onPress={() => step(STEP)}
              />
              <IconButton
                theme={theme}
                icon="Maximize"
                label="Fit"
                disabled={zoomed == null}
                onPress={() => setZoomed(null)}
              />
              {onClose == null ? null : <IconButton theme={theme} icon="X" label="Close" onPress={onClose} />}
            </View>
          </View>
          <View
            {...responder.panHandlers}
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
            style={{
              width: frame.width,
              height: frame.height,
              overflow: "hidden",
              // Phone browsers otherwise pinch-zoom the page and take over drags as native scrolling.
              touchAction: zoomed == null ? "pan-y" : "none",
            }}
          >
            <View pointerEvents="none" style={{ position: "absolute", left: camera.x, top: camera.y }}>
              <Image source={{ uri }} style={{ width: image.width * camera.scale, height: image.height * camera.scale }} />
            </View>
          </View>
        </>
      )}
    </View>
  );
}

function pinch(gesture: Gesture, spread: number, centre: Point): Camera {
  const scaled = zoomAround(gesture.base, gesture.base.scale * (spread / Math.max(gesture.spread, 1)), gesture.centre);
  return { ...scaled, x: scaled.x + centre.x - gesture.centre.x, y: scaled.y + centre.y - gesture.centre.y };
}

function zoomAround(camera: Camera, scale: number, focus: Point): Camera {
  const ratio = scale / camera.scale;
  return { scale, x: focus.x - (focus.x - camera.x) * ratio, y: focus.y - (focus.y - camera.y) * ratio };
}

function fitFor(image: Size, room: Room): number {
  return Math.min(1, room.width / image.width, room.height == null ? 1 : room.height / image.height);
}

function frameFor(image: Size, room: Room, scale: number): Frame {
  const fit = fitFor(image, room);
  const height = room.height ?? Math.max(image.height * fit, Math.min(image.height * scale, MAX_FRAME_HEIGHT));
  return { width: room.width, height, fit };
}

/** Null once zoomed back out to the fit. */
function settle(camera: Camera, image: Size, room: Room): Camera | null {
  const fit = fitFor(image, room);
  const scale = Math.min(Math.max(camera.scale, fit), Math.max(MAX_SCALE, fit));
  if (scale <= fit * FIT_SLACK) return null;
  return place({ ...camera, scale }, image, frameFor(image, room, scale));
}

function isOnImage(point: Point, camera: Camera, image: Size): boolean {
  const x = point.x - camera.x;
  const y = point.y - camera.y;
  return x >= 0 && y >= 0 && x <= image.width * camera.scale && y <= image.height * camera.scale;
}

function place(camera: Camera, image: Size, frame: Size): Camera {
  const along = (offset: number, size: number, room: number) =>
    size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, offset));
  return {
    scale: camera.scale,
    x: along(camera.x, image.width * camera.scale, frame.width),
    y: along(camera.y, image.height * camera.scale, frame.height),
  };
}

function spreadOf(touches: readonly NativeTouchEvent[]): number {
  if (touches.length < 2) return 0;
  return Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
}

/** In the frame's coordinates: touches land on it, the image under them ignoring pointers. */
function centreOf(touches: readonly NativeTouchEvent[]): Point {
  const pair = touches.slice(0, 2);
  const mean = (pick: (touch: NativeTouchEvent) => number) =>
    pair.reduce((sum, touch) => sum + pick(touch), 0) / Math.max(pair.length, 1);
  return { x: mean((touch) => touch.locationX), y: mean((touch) => touch.locationY) };
}
