import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { createOffscreenHost } from "./OffscreenHost.mjs";
import { PREVIEW_LOCAL_SURFACE_FRAME_CHANNEL } from "./channels.mjs";

const artifacts = process.argv[2];
const manifest = {
  status: "starting",
  sessionId: Number(process.argv[3]),
  pid: process.pid,
  versions: process.versions,
  stages: [],
  boundary:
    "Native capture only; original pixels require independent review. No OS input or focus grant.",
};
const saveManifest = () =>
  NodeFSP.writeFile(NodePath.join(artifacts, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
const runtime = import.meta.dirname;
app.setPath("userData", NodePath.join(runtime, "userData"));
app.on("window-all-closed", () => {});
let owner;
let host;
let exitCode = 1;
async function run() {
  try {
    await saveManifest();
    manifest.interactiveSession = manifest.sessionId > 0;
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid}).SessionId`,
    ]);
    manifest.electronSessionId = Number(stdout.trim());
    NodeAssert.equal(manifest.electronSessionId, manifest.sessionId);
    NodeAssert.equal(process.versions.electron, "44.10.0");
    await app.whenReady();
    manifest.displays = screen.getAllDisplays();
    await NodeFSP.mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
    const ownerPreload = NodePath.join(runtime, "owner.cjs");
    await NodeFSP.writeFile(
      ownerPreload,
      `const { ipcRenderer } = require("electron");
ipcRenderer.on(${JSON.stringify(PREVIEW_LOCAL_SURFACE_FRAME_CHANNEL)}, async (_event, frame) => {
  try {
    const bitmap = await createImageBitmap(new Blob([frame.png], { type: "image/png" }));
    const canvas = document.querySelector("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    ipcRenderer.send("pr68-original-frame", frame);
  } catch (error) {
    ipcRenderer.send("pr68-frame-error", String(error));
  }
});`,
      { mode: 0o600 },
    );
    const guestPreload = NodePath.join(runtime, "guest.cjs");
    await NodeFSP.writeFile(guestPreload, "", { mode: 0o600 });
    owner = new BrowserWindow({
      width: 1000,
      height: 700,
      show: true,
      webPreferences: { preload: ownerPreload, sandbox: true, nodeIntegration: false },
    });
    // loadURL waits for the owner document; native paint readiness is checked by frame IPC below.
    manifest.status = "awaiting-owner-did-finish-load";
    await saveManifest();
    const ownerReady = NodeEvents.EventEmitter.once(owner.webContents, "dom-ready");
    await owner.loadURL(
      "data:text/html," +
        encodeURIComponent(
          "<title>PR68 native pixel QA owner</title><style>html,body{margin:0;height:100%;background:#222}canvas{display:block;width:100%;height:100%;object-fit:contain}</style><canvas></canvas>",
        ),
    );
    await ownerReady;
    NodeAssert.equal(owner.getBounds().width, 1000);
    NodeAssert.equal(owner.getBounds().height, 700);
    host = createOffscreenHost({
      tabId: "pr68-windows-qa",
      partition: `pr68-qa-${process.pid}`,
      preload: guestPreload,
      viewport: { _tag: "freeform", width: 1440, height: 1700 },
      zoomFactor: 1,
      deviceScaleFactor: 1,
      additionalArguments: [],
      owner,
      isCurrent: () => true,
      isPrivateEntry: () => false,
      onGone: () => {
        manifest.rendererGone = true;
      },
    });
    const wc = host.webContents;
    const html = `<!doctype html><meta charset="utf-8"><title>PR68 native corners</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f4f4f4;color:#111}
.corner{position:absolute;width:100px;height:100px;font:24px monospace;color:white}
#tl{left:0;top:0;background:#c00000}#tr{right:0;top:0;background:#008000}
#bl{left:0;bottom:0;background:#0000c0}#br{right:0;bottom:0;background:#800080}
#band{position:absolute;left:100px;right:100px;bottom:0;height:48px;background:#ffd000}
#lines{position:absolute;top:140px;left:120px;width:600px;height:100px;
background:repeating-linear-gradient(90deg,#000 0px,#000 1px,#fff 1px,#fff 2px)}
#text{position:absolute;left:120px;top:280px;font-family:Arial,sans-serif}
</style><div id="tl" class="corner">TL red</div><div id="tr" class="corner">TR green</div>
<div id="bl" class="corner">BL blue</div><div id="br" class="corner">BR purple</div>
<div id="band">BOTTOM BAND 1700 CSS px</div><div id="lines"></div>
<div id="text"><p style="font-size:12px">12px: Windows Electron sharp text Il1 0123456789</p>
<p style="font-size:16px">16px: Windows Electron sharp text Il1 0123456789</p>
<p style="font-size:24px">24px: Windows Electron sharp text Il1 0123456789</p></div>`;
    await NodeFSP.writeFile(NodePath.join(artifacts, "fixture.html"), html, { mode: 0o600 });
    manifest.status = "awaiting-guest-did-finish-load";
    await saveManifest();
    const loaded = NodeEvents.EventEmitter.once(wc, "did-finish-load");
    await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await loaded;
    wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Page.enable");
    const identity = async () => ({
      webContentsId: wc.id,
      ...(await wc.executeJavaScript(
        "({timeOrigin:performance.timeOrigin,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
      )),
    });
    const initial = await identity();
    let awaitingFrame;
    ipcMain.on("pr68-frame-error", (event, error) => {
      if (event.sender === owner.webContents && awaitingFrame) {
        awaitingFrame.reject(new Error(error));
        awaitingFrame = undefined;
      }
    });
    ipcMain.on("pr68-original-frame", (event, frame) => {
      if (event.sender !== owner.webContents) return;
      host.ack(frame);
      if (awaitingFrame && frame.surfaceId === awaitingFrame.surfaceId) {
        const pending = awaitingFrame;
        awaitingFrame = undefined;
        pending.resolve(frame);
      }
    });
    for (const [name, zoom, width, height] of [
      ["baseline", 1, 1440, 1700],
      ["zoom125", 1.25, 1800, 2125],
      ["return", 1, 1440, 1700],
    ]) {
      manifest.status = `awaiting-${name}-local-paint`;
      await saveManifest();
      const frameReady = new Promise((resolve, reject) => {
        awaitingFrame = { surfaceId: name, resolve, reject };
      });
      wc.setZoomFactor(zoom);
      host.resize();
      host.present({ tabId: "pr68-windows-qa", surfaceId: name, visible: true });
      const frame = await frameReady;
      const current = await identity();
      const stage = {
        name,
        zoom,
        identity: current,
        localFrame: {
          webContentsId: frame.webContentsId,
          generation: frame.generation,
          sequence: frame.sequence,
          width: frame.width,
          height: frame.height,
        },
        owner: {
          bounds: owner.getBounds(),
          contentBounds: owner.getContentBounds(),
          focused: owner.isFocused(),
          visible: owner.isVisible(),
        },
        guestBounds: host.window.getContentBounds(),
        files: [],
      };
      manifest.stages.push(stage);
      for (const kind of ["local", "capturePage", "cdp"]) {
        manifest.status = `capturing-${name}-${kind}`;
        await saveManifest();
        const png =
          kind === "local"
            ? Buffer.from(frame.png)
            : kind === "capturePage"
              ? (await host.capturePage()).toPNG()
              : Buffer.from(
                  (
                    await wc.debugger.sendCommand("Page.captureScreenshot", {
                      format: "png",
                      captureBeyondViewport: false,
                      fromSurface: true,
                    })
                  ).data,
                  "base64",
                );
        const file = `${name}-${kind}.png`;
        await NodeFSP.writeFile(NodePath.join(artifacts, file), png, { mode: 0o600 });
        const size = nativeImage.createFromBuffer(png).getSize();
        stage.files.push({
          file,
          size,
          bytes: png.length,
          sha256: NodeCrypto.createHash("sha256").update(png).digest("hex"),
        });
        await saveManifest();
        NodeAssert.deepEqual(size, { width, height }, `${file}: unusable/clamped native raster`);
      }
      NodeAssert.equal(current.webContentsId, initial.webContentsId);
      NodeAssert.equal(current.timeOrigin, initial.timeOrigin);
      NodeAssert.equal(current.width, 1440);
      NodeAssert.equal(current.height, 1700);
      NodeAssert.ok(owner.isVisible(), "QA owner must remain visible");
      NodeAssert.equal(manifest.rendererGone, undefined);
      const ownerPng = (await owner.webContents.capturePage()).toPNG();
      const ownerFile = `${name}-owner.png`;
      await NodeFSP.writeFile(NodePath.join(artifacts, ownerFile), ownerPng, { mode: 0o600 });
      stage.files.push({
        file: ownerFile,
        bytes: ownerPng.length,
        sha256: NodeCrypto.createHash("sha256").update(ownerPng).digest("hex"),
      });
    }
    manifest.status = "captured-awaiting-pixel-review";
    exitCode = 0;
  } catch (error) {
    manifest.status = "blocked-or-failed";
    manifest.error = String(error?.stack ?? error);
  } finally {
    await saveManifest();
    host?.dispose();
    if (owner && !owner.isDestroyed()) owner.destroy();
    app.exit(exitCode);
  }
}
// Electron must finish evaluating this entry module before it emits ready.
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
