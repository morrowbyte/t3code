// @effect-diagnostics-next-line nodeBuiltinImport:off - This build fixture checks packaged files and PNG headers synchronously.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const root = new URL("../../", import.meta.url);
const read = (path: string) => NodeFS.readFileSync(new URL(path, root));

describe("Crew installed branding", () => {
  it("has an installable named manifest whose declared PNG dimensions match the existing artwork", () => {
    const manifest = JSON.parse(read("apps/web/public/manifest.webmanifest").toString());
    expect(manifest.name).toBe("Crew Web");
    expect(manifest.short_name).toBe("Crew Web");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const png = manifest.icons.find(
      (icon: { type: string; sizes: string }) =>
        icon.type === "image/png" && icon.sizes === "512x512",
    );
    expect(png).toBeDefined();
    const bytes = read(`apps/web/public${png.src}`);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(png.sizes).toBe(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
    expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(bytes).toEqual(read("assets/crew/web-512.png"));
    expect(manifest.icons).toContainEqual({
      src: "/crew-web.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    });
  });

  it("uses the bundled icon and Crew label for the Nix desktop entry", () => {
    const flake = read("packaging/nixos/flake.nix").toString();
    expect(flake).toContain("Name=Crew");
    expect(flake).toContain("Icon=t3code");
    expect(flake).toContain("Exec=t3code-morrowbyte %U");
    for (const installer of ["packaging/nixos/install.sh", "scripts/morrowbyte/install-linux.sh"]) {
      expect(read(installer).toString()).toContain("Name=Crew");
    }
  });

  it("uses the same existing artwork for browser, Apple install and loading surfaces", () => {
    expect(read("apps/web/public/crew-web.svg")).toEqual(read("assets/crew/web.svg"));
    expect(read("apps/web/public/crew-web.ico")).toEqual(read("assets/crew/web.ico"));
    const html = read("apps/web/index.html").toString();
    expect(html).toContain('<link rel="apple-touch-icon" href="/crew-web-192.png"');
    expect(html).toContain('<link rel="icon" href="/crew-web.ico"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Crew Web"');
    expect(html).toContain("<title>Crew Web</title>");
    expect(html).toContain('src="/crew-native.svg" alt="Crew"');
  });
});
