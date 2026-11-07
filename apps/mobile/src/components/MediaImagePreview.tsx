import type { SendImageAnnotation } from "../lib/imageAnnotation";
import { ImageAnnotationEditor } from "./ImageAnnotationEditor";
import { createContext, useContext, useState } from "react";
import { Pressable, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMediaActions } from "../state/mediaActions";
import type { FilePreviewImages } from "./FilePreviewModal.types";
import { AppText } from "./ui/AppText";
import { MediaPreviewHeader } from "./MediaPreviewHeader";

type MediaImagePreviewProps = {
  readonly source: FilePreviewImages;
  readonly onSendAnnotation?: SendImageAnnotation;
  readonly onAnnotate?: (
    source: FilePreviewImages & { readonly uri: string; readonly name?: string },
  ) => void;
  readonly onRequestClose: () => void;
};

const ImagePreviewContext = createContext<MediaImagePreviewProps | null>(null);

function ImagePreviewHeader(header: { readonly imageIndex: number }) {
  const props = useContext(ImagePreviewContext)!;
  const source = props.source.images[header.imageIndex];
  const insets = useSafeAreaInsets();
  const mediaActions = useMediaActions(source?.actionsSource, props.onRequestClose);
  return (
    <View className="bg-black/70" style={{ paddingTop: insets.top }}>
      <MediaPreviewHeader
        title={source?.name ?? "Image"}
        media={mediaActions}
        closeAccessibilityLabel="Close image"
        onClose={props.onRequestClose}
      />
      {source?.uri && props.onAnnotate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Annotate image"
          onPress={() => {
            if (source.uri)
              props.onAnnotate?.({ ...props.source, ...source, kind: "image", uri: source.uri });
          }}
          className="min-h-12 items-center justify-center px-3"
        >
          <AppText className="text-white">Annotate</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

// Images still resolving show the viewer's loading page, and remount by key once their URL arrives.
export function imageViewingProps(source: FilePreviewImages) {
  return {
    images: source.images.map((image) => (image.uri ? { uri: image.uri } : {})),
    keyExtractor: (_: unknown, index: number) => source.images[index]?.uri ?? `pending:${index}`,
    // Stays fixed: react-native-image-viewing remounts the Modal and replays its fade when it changes.
    imageIndex: source.selectedIndex,
  };
}

export function MediaImagePreview(props: MediaImagePreviewProps) {
  const [annotating, setAnnotating] = useState<{
    readonly source: FilePreviewImages & { readonly uri: string; readonly name?: string };
    readonly onSend: SendImageAnnotation;
  } | null>(null);
  const onSendAnnotation = props.onSendAnnotation;
  if (annotating)
    return (
      <ImageAnnotationEditor
        source={annotating.source}
        onSend={annotating.onSend}
        onRequestClose={() => setAnnotating(null)}
      />
    );
  return (
    <ImagePreviewContext
      value={{
        ...props,
        onAnnotate: onSendAnnotation
          ? (source) => setAnnotating({ source, onSend: onSendAnnotation })
          : undefined,
      }}
    >
      <ImageViewing
        {...imageViewingProps(props.source)}
        visible
        presentationStyle="fullScreen"
        onRequestClose={props.onRequestClose}
        swipeToCloseEnabled={false}
        doubleTapToZoomEnabled
        HeaderComponent={ImagePreviewHeader}
      />
    </ImagePreviewContext>
  );
}
