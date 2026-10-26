#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Deterministic build-time asset exporter; no application runtime state.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const ink = "#292B2E";
const paper = "#F2F1EC";
const source = await NodeFSP.readFile(NodePath.resolve(root, "assets/crew/mark.svg"), "utf8");
const mark = source
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  .trim();
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>\n`;
const tile = (radius: number) => `<rect width="128" height="128" rx="${radius}" fill="${ink}"/>`;
const native = svg(tile(28) + mark);
const square = svg(tile(0) + mark);
// Browser chrome and outlined WEB lettering remain distinct without depending on color or fonts.
const web = svg(
  tile(28) +
    `<rect x="10" y="10" width="108" height="108" rx="18" fill="none" stroke="${paper}" stroke-width="4"/>` +
    `<path d="M28 10H100Q118 10 118 28V39H10V28Q10 10 28 10Z" fill="${paper}"/>` +
    `<g fill="${ink}"><circle cx="23" cy="25" r="3"/><circle cx="34" cy="25" r="3"/><circle cx="45" cy="25" r="3"/></g>` +
    `<path d="M72 20l2 10 3-7 3 7 2-10M92 20h-6v10h6m-6-5h5M96 20v10h5q5 0 5-2.5T101 25h-5m0-5h5q4 0 4 2.5T101 25" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linejoin="round"/>` +
    `<g transform="translate(17 30) scale(.73)">${mark}</g>`,
);
// The artwork fits inside Android's central circular 66/108 safe zone, including its diagonals.
const adaptive = svg(`<g transform="translate(28.8 28.8) scale(.55)">${mark}</g>`);
const monochrome = adaptive.replaceAll(/#[A-Fa-f0-9]{6}/g, "#FFFFFF");
const notification = svg(mark.replaceAll(/#[A-Fa-f0-9]{6}/g, "#FFFFFF"));
const png = (sourceSvg: string, size: number) =>
  sharp(Buffer.from(sourceSvg), { density: 288 }).resize(size, size).png().toBuffer();
const ico = async (sourceSvg: string) =>
  encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await png(sourceSvg, size) })),
    ),
  );

const outputs = new Map<string, Buffer>();
const put = (path: string, contents: Buffer | string) => outputs.set(path, Buffer.from(contents));
put("assets/crew/native.svg", native);
put("assets/crew/web.svg", web);
put("assets/crew/native-1024.png", await png(square, 1024));
put("assets/crew/desktop-1024.png", await png(native, 1024));
put("assets/crew/native.ico", await ico(native));
put("assets/crew/web.ico", await ico(web));
for (const size of [16, 32, 180, 192, 512]) {
  put(`assets/crew/web-${size}.png`, await png(web, size));
}
for (const directory of ["apps/web/public", "apps/marketing/public"]) {
  put(`${directory}/crew-web.svg`, web);
  put(`${directory}/crew-native.svg`, native);
  put(`${directory}/crew-native-1024.png`, outputs.get("assets/crew/native-1024.png")!);
  put(`${directory}/crew-web.ico`, outputs.get("assets/crew/web.ico")!);
  for (const size of [192, 512])
    put(`${directory}/crew-web-${size}.png`, outputs.get(`assets/crew/web-${size}.png`)!);
  put(`${directory}/favicon.ico`, outputs.get("assets/crew/web.ico")!);
  put(`${directory}/apple-touch-icon.png`, outputs.get("assets/crew/web-180.png")!);
  for (const size of [16, 32])
    put(`${directory}/favicon-${size}x${size}.png`, outputs.get(`assets/crew/web-${size}.png`)!);
}
put("apps/mobile/assets/android-icon-foreground.png", await png(adaptive, 432));
put("apps/mobile/assets/android-icon-mark.png", await png(monochrome, 432));
put("apps/mobile/assets/android-notification-icon.png", await png(notification, 96));
for (const variant of ["prod", "nightly", "dev"]) {
  put(`apps/mobile/assets/android-splash-icon-${variant}.png`, await png(adaptive, 1152));
}

// Release installers are distributed without a repository checkout or an adjacent icon file.
const installerPath = "scripts/morrowbyte/install-linux.sh";
const installer = await NodeFSP.readFile(NodePath.resolve(root, installerPath), "utf8");
const installerIcon = /(# crew-icon:start[^\n]*\n)[\s\S]*?(# crew-icon:end)/;
if (!installerIcon.test(installer)) throw new Error("Linux installer icon markers are missing.");
put(
  installerPath,
  installer.replace(installerIcon, `$1cat > "$icon_path" <<'CREW_ICON'\n${native}CREW_ICON\n$2`),
);

const stale: Array<string> = [];
for (const [path, contents] of outputs) {
  const target = NodePath.resolve(root, path);
  if (check) {
    const actual = await NodeFSP.readFile(target).catch(() => null);
    if (!actual?.equals(contents)) stale.push(path);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, contents);
  }
}
if (stale.length) throw new Error(`Crew icons are stale:\n${stale.join("\n")}`);
console.log(`${check ? "Verified" : "Wrote"} ${outputs.size} Crew icon assets.`);
