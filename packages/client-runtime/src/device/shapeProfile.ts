import { resolveDeviceModelId } from "./model.ts";
import type { DevicePlatform } from "@t3tools/contracts";

export interface DeviceShapeProfile {
  readonly id:
    | "ios-phone"
    | "ios-tablet"
    | "android-phone"
    | "android-tablet"
    | "android-galaxy-s24-ultra";
  readonly bodyDimensions?: {
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly displayHeight: number;
    readonly displayAspect: number;
  };
  readonly punchHole?: { readonly radius: number; readonly inset: number };
  readonly bezel: number;
  readonly bodyRadius: number;
  readonly screenRadius: number;
  readonly depth: number;
  readonly backColor: number;
  readonly buttons: ReadonlyArray<{
    readonly edge: "left" | "right" | "top";
    readonly offset: number;
    readonly length: number;
  }>;
  readonly camera: {
    readonly separateRings?: boolean;
    readonly radii?: ReadonlyArray<number>;
    readonly width: number;
    readonly height: number;
    readonly insetX: number;
    readonly insetY: number;
    readonly lensRadius: number;
    readonly lenses: ReadonlyArray<readonly [number, number]>;
    readonly flash: readonly [number, number] | null;
  };
}

export const IOS_PHONE_SHAPE: DeviceShapeProfile = {
  id: "ios-phone",
  bezel: 0.055,
  bodyRadius: 0.15,
  screenRadius: 0.105,
  depth: 0.085,
  backColor: 0x424b5d,
  buttons: [
    { edge: "right", offset: 0.35, length: 0.3 },
    { edge: "left", offset: 0.48, length: 0.18 },
    { edge: "left", offset: 0.22, length: 0.18 },
  ],
  camera: {
    width: 0.39,
    height: 0.44,
    insetX: 0.25,
    insetY: 0.29,
    lensRadius: 0.068,
    lenses: [
      [-0.08, 0.095],
      [0.08, -0.095],
    ],
    flash: [0.085, 0.11],
  },
};

export const IOS_TABLET_SHAPE: DeviceShapeProfile = {
  id: "ios-tablet",
  bezel: 0.065,
  bodyRadius: 0.105,
  screenRadius: 0.045,
  depth: 0.055,
  backColor: 0x9ca5af,
  buttons: [
    { edge: "top", offset: 0.5, length: 0.15 },
    { edge: "right", offset: 0.78, length: 0.13 },
    { edge: "right", offset: 0.58, length: 0.13 },
  ],
  camera: {
    width: 0.19,
    height: 0.19,
    insetX: 0.15,
    insetY: 0.15,
    lensRadius: 0.045,
    lenses: [[0, 0]],
    flash: null,
  },
};

export const ANDROID_PHONE_SHAPE: DeviceShapeProfile = {
  id: "android-phone",
  bezel: 0.035,
  bodyRadius: 0.115,
  screenRadius: 0.08,
  depth: 0.085,
  backColor: 0x344449,
  buttons: [
    { edge: "right", offset: 0.2, length: 0.24 },
    { edge: "right", offset: 0.65, length: 0.32 },
  ],
  camera: {
    width: 0.24,
    height: 0.47,
    insetX: 0.18,
    insetY: 0.29,
    lensRadius: 0.056,
    lenses: [
      [0, 0.11],
      [0, -0.11],
    ],
    flash: [0.1, 0],
  },
};

// Original procedural geometry; no third-party mesh or texture. Dimensions in millimetres.
// https://news.samsung.com/global/enter-the-new-era-of-mobile-ai-with-samsung-galaxy-s24-series
export const GALAXY_S24_ULTRA_SHAPE: DeviceShapeProfile = {
  id: "android-galaxy-s24-ultra",
  bodyDimensions: {
    width: 79,
    height: 162.3,
    depth: 8.6,
    displayHeight: (172.5 * 3120) / Math.hypot(1440, 3120),
    displayAspect: 1440 / 3120,
  },
  bezel: 0.024,
  bodyRadius: 0.028,
  screenRadius: 0.016,
  depth: 0.122,
  backColor: 0x9b9790,
  punchHole: { radius: 0.014, inset: 0.046 },
  buttons: [
    { edge: "right", offset: 0.45, length: 0.25 },
    { edge: "right", offset: 0.12, length: 0.15 },
  ],
  camera: {
    separateRings: true,
    width: 0.38,
    height: 0.62,
    insetX: 0.18,
    insetY: 0.22,
    lensRadius: 0.071,
    lenses: [
      [0, 0],
      [0, -0.23],
      [0, -0.46],
      [0.22, -0.015],
      [0.22, -0.245],
    ],
    radii: [0.071, 0.071, 0.071, 0.041, 0.041],
    flash: [0.22, -0.13],
  },
};

const ANDROID_TABLET_SHAPE: DeviceShapeProfile = {
  ...IOS_TABLET_SHAPE,
  id: "android-tablet",
  backColor: 0x697b80,
};

export function resolveDeviceShape(options: {
  platform: DevicePlatform;
  name?: string;
  portraitAspect: number;
}): DeviceShapeProfile {
  const name = options.name ?? "";
  if (resolveDeviceModelId(options.platform, name) === "galaxy-s24-ultra")
    return GALAXY_S24_ULTRA_SHAPE;
  const namedTablet = /\b(ipad|tablet)\b/i.test(name);
  const namedPhone = /\b(iphone|phone)\b/i.test(name);
  const tablet = namedTablet || (!namedPhone && options.portraitAspect >= 0.6);
  return options.platform === "ios"
    ? tablet
      ? IOS_TABLET_SHAPE
      : IOS_PHONE_SHAPE
    : tablet
      ? ANDROID_TABLET_SHAPE
      : ANDROID_PHONE_SHAPE;
}
