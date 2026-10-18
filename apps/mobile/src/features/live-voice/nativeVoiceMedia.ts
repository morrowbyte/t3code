import { requestRecordingPermissionsAsync } from "expo-audio";
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

export const nativeVoiceMedia = {
  getUserMedia: async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Microphone permission is required.");
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    releaseNativeStreamOnStop(stream);
    return stream as unknown as MediaStream;
  },
  createPeer: () => new NativePeer() as unknown as LiveVoicePeer,
  createRemoteStream: (track) =>
    new NativeMediaStream([track as unknown as NativeTrack]) as unknown as MediaStream,
  createAudioSink: createNativeAudioSink,
} satisfies Pick<
  LiveVoiceControllerDependencies,
  "getUserMedia" | "createPeer" | "createRemoteStream" | "createAudioSink"
>;
