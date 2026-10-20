import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import {
  mediaDevices,
  MediaStream as NativeMediaStream,
  RTCPeerConnection as NativePeer,
  type MediaStreamTrack as NativeTrack,
} from "react-native-webrtc";
import type {
  LiveVoiceControllerDependencies,
  LiveVoicePeer,
} from "@t3tools/client-runtime/live-voice";
import { createNativeAudioSink, releaseNativeStreamOnStop } from "./nativeVoiceAudio";
import { beginNativeVoiceBackground } from "./nativeVoiceBackground";

export const nativeVoiceMedia = {
  getUserMedia: async () => {
    const current = await getRecordingPermissionsAsync();
    const permission = current.granted ? current : await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Microphone permission is required.");
    const endBackground = await beginNativeVoiceBackground();
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      releaseNativeStreamOnStop(stream, () => {
        void endBackground().catch(() => {});
      });
      return stream as unknown as MediaStream;
    } catch (error) {
      await endBackground();
      throw error;
    }
  },
  createPeer: () => new NativePeer() as unknown as LiveVoicePeer,
  createRemoteStream: (track) =>
    new NativeMediaStream([track as unknown as NativeTrack]) as unknown as MediaStream,
  createAudioSink: createNativeAudioSink,
} satisfies Pick<
  LiveVoiceControllerDependencies,
  "getUserMedia" | "createPeer" | "createRemoteStream" | "createAudioSink"
>;
