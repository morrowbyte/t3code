import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { BoatProjectConfig, DEFAULT_BOAT_PROJECT } from "./boat.ts";

const decode = Schema.decodeUnknownSync(BoatProjectConfig);
const encode = Schema.encodeSync(BoatProjectConfig);

it("keeps older Boat projects without a private Android target", () => {
  const { privateAndroidTarget: _, ...legacy } = {
    ...DEFAULT_BOAT_PROJECT,
    privateAndroidTarget: null,
  };
  expect(decode(legacy)).toMatchObject({
    previewKind: "web",
    privateAndroidTarget: null,
  });
});

it("preserves the explicitly selected private Android host and device", () => {
  const project = decode({
    ...DEFAULT_BOAT_PROJECT,
    webAccess: "private",
    previewKind: "android",
    privateAndroidTarget: { hostId: "boat-android", deviceId: "Pixel_9" },
  });
  expect(decode(encode(project))).toMatchObject({
    privateAndroidTarget: { hostId: "boat-android", deviceId: "Pixel_9" },
  });
});

it.each([
  { hostId: "", deviceId: "Pixel_9" },
  { hostId: "boat-android", deviceId: " " },
  { hostId: "h".repeat(129), deviceId: "Pixel_9" },
  { hostId: "boat-android", deviceId: "d".repeat(257) },
])("rejects an invalid private Android target %j", (privateAndroidTarget) => {
  expect(() => decode({ ...DEFAULT_BOAT_PROJECT, privateAndroidTarget })).toThrow();
});
