import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal, PanResponder, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Image as SvgImage, Path } from "react-native-svg";
import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import {
  annotationImageRect,
  annotationPath,
  annotationPoint,
  annotationRasterSize,
  type AnnotationPoint,
  type AnnotationStroke,
  type SendImageAnnotation,
} from "../lib/imageAnnotation";
import { uuidv4 } from "../lib/uuid";
import { AppText } from "./ui/AppText";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

const COLORS = ["#EF4444", "#FACC15", "#38BDF8", "#111827", "#FFFFFF"];
const WIDTHS = [0.004, 0.008, 0.016];
const MAX_POINTS = 10_000;

async function prepareAnnotationImage(uri: string) {
  const rendered = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const size = annotationRasterSize(rendered.width, rendered.height);
    const saved = await rendered.saveAsync({ format: SaveFormat.PNG });
    return { uri: saved.uri, ...size };
  } finally {
    rendered.release();
  }
}

async function exportAnnotationImage(
  view: Svg,
  image: { width: number; height: number },
  ownedFiles: Set<string>,
  signal: AbortSignal,
  isMounted: () => boolean,
) {
  const base64 = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Image export timed out. Your image has not been sent.")),
      15_000,
    );
    try {
      view.toDataURL(
        (bytes) => {
          clearTimeout(timeout);
          if (bytes) resolve(bytes);
          else reject(new Error("Image export returned no bytes."));
        },
        { width: image.width, height: image.height },
      );
    } catch (cause) {
      clearTimeout(timeout);
      reject(cause);
    }
  });
  if (!isMounted()) return null;
  const file = new File(Paths.cache, `annotation-${uuidv4()}.png`);
  ownedFiles.add(file.uri);
  await file.write(base64, { encoding: "base64" });
  if (!isMounted() || signal.aborted) {
    if (file.exists) file.delete();
    return null;
  }
  if (!file.size) throw new Error("Image export returned an empty file. Nothing was sent.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("The annotated image exceeds the 10 MB attachment limit.");
  return file;
}

async function settleAnnotationSend(
  operation: () => Promise<void>,
  onError: (cause: unknown) => void,
  onSettled: () => void,
) {
  try {
    await operation();
  } catch (cause) {
    onError(cause);
  } finally {
    onSettled();
  }
}

function Tool(props: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-12 min-w-12 justify-center rounded-lg border border-border px-3 py-2"
      style={{ opacity: props.disabled ? 0.4 : 1, maxWidth: "100%" }}
    >
      <AppText className={props.selected ? "font-t3-semibold text-accent" : "text-foreground"}>
        {props.label}
      </AppText>
    </Pressable>
  );
}

export function ImageAnnotationEditor(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onSend: SendImageAnnotation;
  readonly onRequestClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const svg = useRef<Svg>(null);
  const activeSend = useRef<AbortController | null>(null);
  const [image, setImage] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  const imageLoaded = image !== null && loadedUri === image.uri;
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [strokes, setStrokes] = useState<readonly (AnnotationStroke & { readonly key: string })[]>(
    [],
  );
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(WIDTHS[1]!);
  const [mode, setMode] = useState<"Draw" | "Move">("Draw");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<AnnotationPoint>({ x: 0, y: 0 });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const ownedFiles = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      const saved = await prepareAnnotationImage(props.source.uri);
      if (cancelled) {
        new File(saved.uri).delete();
        return;
      }
      ownedFiles.current.add(saved.uri);
      setImage(saved);
    })().catch((cause: unknown) => {
      if (!cancelled)
        setError(cause instanceof Error ? cause.message : "Could not load the image.");
    });
    const files = ownedFiles.current;
    return () => {
      cancelled = true;
      mounted.current = false;
      activeSend.current?.abort();
      for (const uri of files) {
        const file = new File(uri);
        if (file.exists) file.delete();
      }
    };
  }, [props.source.uri]);

  useEffect(() => {
    if (!image || imageLoaded) return;
    const timeout = setTimeout(
      () => setError("Could not load the original image for export. Close and retry."),
      15_000,
    );
    return () => clearTimeout(timeout);
  }, [image, imageLoaded]);

  const rect = image ? annotationImageRect(image, viewport, zoom, pan) : null;
  const current = useRef({ rect, mode, color, width, sending, strokes, pan });
  useLayoutEffect(() => {
    current.current = { rect, mode, color, width, sending, strokes, pan };
  });
  const drawing = useRef(false);
  const panStart = useRef(pan);
  const [responder, setResponder] = useState<ReturnType<typeof PanResponder.create> | null>(null);
  useEffect(() => {
    setResponder(
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          !current.current.sending && current.current.rect !== null,
        onMoveShouldSetPanResponder: () => !current.current.sending,
        onPanResponderGrant: (event) => {
          const value = current.current;
          panStart.current = value.pan;
          if (value.mode !== "Draw" || !value.rect || value.strokes.length >= 100) return;
          const point = annotationPoint(
            { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
            value.rect,
          );
          drawing.current = point !== null;
          if (point)
            setStrokes((old) => [
              ...old,
              { key: uuidv4(), color: value.color, width: value.width, points: [point] },
            ]);
        },
        onPanResponderMove: (event, gesture) => {
          const value = current.current;
          if (value.mode === "Move") {
            setPan({ x: panStart.current.x + gesture.dx, y: panStart.current.y + gesture.dy });
            return;
          }
          if (!drawing.current || !value.rect) return;
          const point = annotationPoint(
            { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
            value.rect,
          );
          if (!point) return;
          setStrokes((old) => {
            const last = old.at(-1);
            if (
              !last ||
              old.reduce((count, stroke) => count + stroke.points.length, 0) >= MAX_POINTS
            )
              return old;
            return [...old.slice(0, -1), { ...last, points: [...last.points, point] }];
          });
        },
        onPanResponderRelease: () => {
          drawing.current = false;
        },
        onPanResponderTerminate: () => {
          drawing.current = false;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    );
  }, []);

  async function send() {
    if (sendingRef.current || !image || !imageLoaded || !svg.current || strokes.length === 0)
      return;
    const view = svg.current;
    const controller = new AbortController();
    activeSend.current = controller;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    await settleAnnotationSend(
      async () => {
        const file = await exportAnnotationImage(
          view,
          image,
          ownedFiles.current,
          controller.signal,
          () => mounted.current,
        );
        if (!file) return;
        const name = `${(props.source.name ?? "Image").replace(/\.[^.]+$/, "")}-annotated.png`;
        const sent = await props.onSend(
          { uri: file.uri, name, width: image.width, height: image.height },
          text,
          controller.signal,
        );
        if (sent && mounted.current && !controller.signal.aborted) props.onRequestClose();
      },
      (cause) => {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : "Could not send the annotated image.");
      },
      () => {
        if (activeSend.current === controller) activeSend.current = null;
        sendingRef.current = false;
        if (mounted.current) setSending(false);
      },
    );
  }

  return (
    <Modal
      visible
      presentationStyle="fullScreen"
      onRequestClose={() => {
        activeSend.current?.abort();
        props.onRequestClose();
      }}
    >
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="gap-2 p-3">
          <AppText className="text-lg font-t3-semibold">Annotate image</AppText>
          <View className="flex-row flex-wrap gap-2">
            <Tool
              label="Cancel"
              onPress={() => {
                activeSend.current?.abort();
                props.onRequestClose();
              }}
            />
            <Tool
              label={sending ? "Sending…" : "Send annotated image"}
              disabled={sending || !imageLoaded || strokes.length === 0}
              onPress={() => void send()}
            />
          </View>
        </View>
        <ScrollView
          horizontal
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}
        >
          <Tool
            label="Draw"
            selected={mode === "Draw"}
            disabled={sending}
            onPress={() => setMode("Draw")}
          />
          <Tool
            label="Move"
            selected={mode === "Move"}
            disabled={sending}
            onPress={() => setMode("Move")}
          />
          <Tool
            label="Undo"
            disabled={sending || strokes.length === 0}
            onPress={() => setStrokes((old) => old.slice(0, -1))}
          />
          <Tool
            label="Clear"
            disabled={sending || strokes.length === 0}
            onPress={() => setStrokes([])}
          />
          <Tool
            label="Zoom in"
            disabled={sending || zoom >= 4}
            onPress={() => setZoom((value) => Math.min(4, value * 2))}
          />
          <Tool
            label="Zoom out"
            disabled={sending || zoom <= 1}
            onPress={() => setZoom((value) => Math.max(1, value / 2))}
          />
          <Tool
            label="Fit"
            disabled={sending}
            onPress={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          />
        </ScrollView>
        <View className="flex-row flex-wrap gap-2 px-3 pb-2">
          {COLORS.map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`Color ${value}`}
              accessibilityState={{ selected: value === color }}
              disabled={sending}
              onPress={() => setColor(value)}
              className="h-12 w-12 items-center justify-center rounded-lg border border-border"
            >
              <View
                style={{
                  width: value === color ? 28 : 20,
                  height: value === color ? 28 : 20,
                  borderRadius: 14,
                  backgroundColor: value,
                  borderWidth: 1,
                  borderColor: "#808080",
                }}
              />
            </Pressable>
          ))}
          {WIDTHS.map((value, index) => (
            <Tool
              key={value}
              label={["Thin", "Medium", "Thick"][index]!}
              selected={value === width}
              disabled={sending}
              onPress={() => setWidth(value)}
            />
          ))}
        </View>
        {error ? (
          <AppText accessibilityRole="alert" className="px-3 py-2 text-destructive">
            {error}
          </AppText>
        ) : null}
        <View
          accessibilityLabel="Annotation canvas"
          className="flex-1 overflow-hidden bg-black/10"
          onLayout={(event) => setViewport(event.nativeEvent.layout)}
          {...responder?.panHandlers}
        >
          {image && rect ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }}
            >
              <Svg
                ref={svg}
                width="100%"
                height="100%"
                viewBox={`0 0 ${image.width} ${image.height}`}
              >
                <SvgImage
                  href={{ uri: image.uri }}
                  x={0}
                  y={0}
                  width={image.width}
                  height={image.height}
                  onLoad={() => setLoadedUri(image.uri)}
                />
                {strokes.map((stroke) =>
                  stroke.points.length === 1 ? (
                    <Circle
                      key={stroke.key}
                      cx={stroke.points[0]!.x * image.width}
                      cy={stroke.points[0]!.y * image.height}
                      r={Math.max(1, stroke.width * Math.min(image.width, image.height)) / 2}
                      fill={stroke.color}
                    />
                  ) : (
                    <Path
                      key={stroke.key}
                      d={annotationPath(stroke.points, image.width, image.height)}
                      fill="none"
                      stroke={stroke.color}
                      strokeWidth={Math.max(1, stroke.width * Math.min(image.width, image.height))}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ),
                )}
              </Svg>
            </View>
          ) : (
            <AppText className="p-4">{error ? "" : "Loading image…"}</AppText>
          )}
        </View>
        <TextInput
          accessibilityLabel="Annotation message"
          placeholder="Message"
          multiline
          editable={!sending}
          value={text}
          onChangeText={setText}
          className="m-3 max-h-28 min-h-12 rounded-lg border border-border px-3 py-2 text-foreground"
        />
      </View>
    </Modal>
  );
}
