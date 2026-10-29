import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

const { applyOptionalObserve } = NodeModule.createRequire(import.meta.url)(
  "./withOptionalObserve.cjs",
) as { applyOptionalObserve: (contents: string, projectId: unknown) => string };

const template = `plugins { id("expo-autolinking-settings") }
expoAutolinking.exclude = ["another-module"]
expoAutolinking.useExpoModules()
expoAutolinking.useExpoVersionCatalog()
`;

describe("optional native Observe", () => {
  it.each([undefined, null, "", " "])(
    "excludes the crashing module before native registration without project ID %j",
    (projectId) => {
      const result = applyOptionalObserve(template, projectId);
      expect(result).toContain('expoAutolinking.exclude = ["another-module"]');
      expect(result).toContain(
        'expoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ["expo-observe"]',
      );
      expect(result.indexOf('+ ["expo-observe"]')).toBeLessThan(
        result.indexOf("expoAutolinking.useExpoModules()"),
      );
      expect(applyOptionalObserve(result, projectId)).toBe(result);
      expect(applyOptionalObserve(result, "configured-project")).toBe(template);
    },
  );

  it("preserves autolinking for configured builds and diagnoses an unsupported template", () => {
    expect(applyOptionalObserve(template, "configured-project")).toBe(template);
    expect(() => applyOptionalObserve("unknown template", undefined)).toThrow(
      "Expo settings.gradle autolinking template",
    );
  });
});
