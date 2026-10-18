import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

const { applyReleaseSigning } = NodeModule.createRequire(import.meta.url)(
  "./withAndroidReleaseSigning.cjs",
) as {
  applyReleaseSigning: (source: string) => string;
};
const template = `apply plugin: "com.android.application"
android {
    signingConfigs { debug { storeFile file('debug.keystore') } }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}`;

describe("fork Android release signing", () => {
  it("keeps debug usable and makes release require its own PKCS12 signing environment", () => {
    const result = applyReleaseSigning(template);
    expect(result).toContain("debug { signingConfig signingConfigs.debug }");
    expect(result).toMatch(/release\s*\{\s*signingConfig signingConfigs.morrowbyteRelease/);
    expect(result).toContain('storeType "PKCS12"');
    expect(result).toContain('System.getenv("MORROWBYTE_ANDROID_KEYSTORE_PATH")');
    expect(result).toContain("throw new GradleException");
    expect(applyReleaseSigning(result)).toBe(result);
  });
  it("fails closed when release signing is no longer the known Expo template", () => {
    expect(() => applyReleaseSigning(template.replace("release {", "changedRelease {"))).toThrow(
      "template changed",
    );
  });
});
