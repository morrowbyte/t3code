import { Box3, Mesh, PerspectiveCamera, Texture, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";
import { resolveDeviceShape } from "./shapeProfile.ts";
import { createPhoneScene, phoneDisplayLayout } from "./phoneScene.ts";
import {
  IOS_TABLET_SHAPE,
  IOS_PHONE_SHAPE,
  ANDROID_PHONE_SHAPE,
  GALAXY_S24_ULTRA_SHAPE,
} from "./shapeProfile.ts";

const orientations = [
  "portrait",
  "landscape_left",
  "landscape_right",
  "portrait_upside_down",
] as const;

describe("3D phone input", () => {
  it.each([IOS_TABLET_SHAPE, IOS_PHONE_SHAPE, ANDROID_PHONE_SHAPE, GALAXY_S24_ULTRA_SHAPE])(
    "preserves input projection for the $id silhouette in every orientation",
    (profile) => {
      for (const orientation of orientations) {
        for (const zoom of [0.6, 1, 2.2]) {
          const texture = new Texture();
          const aspect =
            profile.id === "ios-tablet"
              ? 0.75
              : profile.id === "android-galaxy-s24-ultra"
                ? 1440 / 3120
                : 0.45;
          const layout = phoneDisplayLayout(
            { width: 1200 * aspect, height: 1200, orientation },
            1200 * aspect,
            1200,
          );
          const phone = createPhoneScene(texture, layout, profile);
          const camera = new PerspectiveCamera(32, 1, 0.1, 30);
          camera.position.z = 6 / zoom;
          camera.updateMatrixWorld(true);
          phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
          phone.orientation.rotation.z = layout.rotation;
          phone.root.updateMatrixWorld(true);
          const point = new Vector3((-2.2 * aspect) / 4, -2.2 / 4, 0.043);
          phone.orientation.localToWorld(point);
          point.project(camera);
          const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
          const expected =
            orientation === "landscape_left"
              ? { x: 0.25, y: 0.25 }
              : orientation === "landscape_right"
                ? { x: 0.75, y: 0.75 }
                : orientation === "portrait_upside_down"
                  ? { x: 0.75, y: 0.25 }
                  : { x: 0.25, y: 0.75 };
          expect(hit?.x).toBeCloseTo(expected.x);
          expect(hit?.y).toBeCloseTo(expected.y);
          phone.dispose();
          texture.dispose();
        }
      }
    },
  );
  it.each([0.6, 2.2])("keeps device coordinates accurate at %s camera zoom", (zoom) => {
    const texture = new Texture();
    const layout = phoneDisplayLayout(null, 900, 1950);
    const phone = createPhoneScene(texture, layout);
    const camera = new PerspectiveCamera(32, 0.65, 0.1, 30);
    camera.position.z = 6 / zoom;
    camera.updateMatrixWorld(true);
    phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
    phone.root.updateMatrixWorld(true);
    const point = new Vector3((-2.2 * layout.aspect) / 4, -2.2 / 4, 0.043);
    phone.orientation.localToWorld(point);
    point.project(camera);
    const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    expect(hit?.x).toBeCloseTo(0.25);
    expect(hit?.y).toBeCloseTo(0.75);
    phone.dispose();
    texture.dispose();
  });

  it("rejects new gestures outside the display, but clamps captured drags at its edge", () => {
    const texture = new Texture();
    const phone = createPhoneScene(texture, phoneDisplayLayout(null, 900, 1950));
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 5;
    expect(phone.screenPoint(1, 0.5, camera)).toBeNull();
    expect(phone.screenPoint(1, 0.5, camera, true)).toEqual({ x: 1, y: 0.5 });
    phone.root.rotation.y = Math.PI;
    expect(phone.screenPoint(0.5, 0.5, camera)).toBeNull();
    phone.dispose();
    texture.dispose();
  });

  it.each(["landscape_left", "landscape_right"] as const)(
    "unrotates an already-landscape framebuffer in %s",
    (orientation) => {
      const texture = new Texture();
      const layout = phoneDisplayLayout({ width: 1950, height: 900, orientation }, 1950, 900);
      const phone = createPhoneScene(texture, layout);
      phone.orientation.rotation.z = layout.rotation;
      const camera = new PerspectiveCamera(32, 1, 0.1, 30);
      camera.position.z = 5;
      expect(phone.screenPoint(0.5, 0.5, camera)).toEqual({ x: 0.5, y: 0.5 });
      phone.dispose();
      texture.dispose();
    },
  );
});

it("builds the S24 shell with physical proportions, separate rings and a centered punch hole", () => {
  const texture = new Texture();
  const phone = createPhoneScene(
    texture,
    phoneDisplayLayout(null, 1440, 3120),
    GALAXY_S24_ULTRA_SHAPE,
  );
  expect(phone.width / phone.height).toBeCloseTo(79 / 162.3, 6);
  expect(phone.root.getObjectByName("camera-plate")).toBeUndefined();
  const camera = phone.root.getObjectByName("rear-camera")!;
  const rings = camera.children.filter((child) => child.name === "camera-ring");
  expect(rings).toHaveLength(5);
  phone.root.updateMatrixWorld(true);
  for (const part of camera.children) {
    const bounds = new Box3().setFromObject(part);
    expect(bounds.min.x).toBeGreaterThan(-phone.width / 2);
    expect(bounds.max.x).toBeLessThan(phone.width / 2);
    expect(bounds.min.y).toBeGreaterThan(-phone.height / 2);
    expect(bounds.max.y).toBeLessThan(phone.height / 2);
  }
  const rearX = rings.map((ring) => -ring.getWorldPosition(new Vector3()).x);
  for (const small of rearX.slice(3)) {
    for (const large of rearX.slice(0, 3)) expect(small).toBeGreaterThan(large);
  }
  expect(phone.root.getObjectByName("front-camera")?.position.x).toBe(0);
  expect(phone.orientation.children.filter((child) => child.name === "side-button")).toHaveLength(
    2,
  );
  expect(phone.root.getObjectByName("display")).toBeInstanceOf(Mesh);
  phone.dispose();
  texture.dispose();
});

it("selects S24 geometry by name without changing generic Android profiles", () => {
  expect(
    resolveDeviceShape({ platform: "android", name: "SM-S928B", portraitAspect: 1440 / 3120 }),
  ).toBe(GALAXY_S24_ULTRA_SHAPE);
  expect(
    resolveDeviceShape({ platform: "android", name: "Pixel 9", portraitAspect: 1440 / 3120 }),
  ).toBe(ANDROID_PHONE_SHAPE);
});

it.each(["landscape_left", "landscape_right"] as const)(
  "projects S24 landscape pixels and captured drags in %s",
  (orientation) => {
    const texture = new Texture();
    const layout = phoneDisplayLayout({ width: 3120, height: 1440, orientation }, 3120, 1440);
    const phone = createPhoneScene(texture, layout, GALAXY_S24_ULTRA_SHAPE);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 5;
    camera.updateMatrixWorld(true);
    phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
    phone.orientation.rotation.z = layout.rotation;
    phone.root.updateMatrixWorld(true);
    const point = new Vector3((-2.2 * layout.aspect) / 4, -2.2 / 4, 0.043);
    phone.orientation.localToWorld(point).project(camera);
    for (const captured of [false, true]) {
      const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera, captured);
      const expected = orientation === "landscape_left" ? 0.25 : 0.75;
      expect(hit?.x).toBeCloseTo(expected);
      expect(hit?.y).toBeCloseTo(expected);
    }
    phone.dispose();
    texture.dispose();
  },
);
