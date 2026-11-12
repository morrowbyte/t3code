import { shareAsync, type SharingOptions } from "expo-sharing";
import { requireNativeModule } from "expo";
import { Platform } from "react-native";

export function shareFileFromSource(
  uri: string,
  options: SharingOptions,
  _sourceIdentifier?: string,
) {
  if (Platform.OS === "android") {
    return requireNativeModule<{
      shareFile(uri: string, mimeType: string, title: string): Promise<void>;
    }>("T3NativeControls").shareFile(
      uri,
      options.mimeType || "application/octet-stream",
      options.dialogTitle || "",
    );
  }
  return shareAsync(uri, options);
}
