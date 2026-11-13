import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it, onTestFinished } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";

// quarantine: #68 Native Windows Electron pixels require a Windows desktop session.
it.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "retains native viewport pixels and guest identity across zoom",
  async () => {
    const artifactsRoot = process.env.T3CODE_NATIVE_PREVIEW_ARTIFACTS ?? NodeOS.tmpdir();
    await NodeFSP.mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    const artifacts = await NodeFSP.mkdtemp(NodePath.join(artifactsRoot, "pr68-windows-"));
    console.info(`PR68 original artifacts (retained for owner review): ${artifacts}`);
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid}).SessionId`,
    ]);
    const sessionId = Number(stdout.trim());
    await NodeFSP.writeFile(
      NodePath.join(artifacts, "session.json"),
      JSON.stringify(
        {
          platform: HostProcess.Platform.defaultValue(),
          sessionId,
          node: process.version,
          interactiveSession: Number.isInteger(sessionId) && sessionId > 0,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    expect(Number.isInteger(sessionId), "PowerShell must report the actual process session").toBe(
      true,
    );
    expect(sessionId).toBeGreaterThanOrEqual(0);

    const runtime = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pr68-electron-runtime-"));
    let cleanup = () => NodeFSP.rm(runtime, { recursive: true, force: true });
    onTestFinished(() => cleanup());
    await NodeFSP.mkdir(NodePath.join(runtime, "userData"), { mode: 0o700 });
    const sourcePaths = ["./OffscreenHost.ts", "../ipc/channels.ts"];
    const sources = [];
    for (const [index, relative] of sourcePaths.entries()) {
      const path = NodeURL.fileURLToPath(new URL(relative, import.meta.url));
      const source = await NodeFSP.readFile(path, "utf8");
      const erased = NodeModule.stripTypeScriptTypes(source, { mode: "strip" });
      const output = index === 0 ? "OffscreenHost.mjs" : "channels.mjs";
      const loaded = erased.replace('"../ipc/channels.ts"', '"./channels.mjs"');
      await NodeFSP.writeFile(NodePath.join(runtime, output), loaded, { mode: 0o600 });
      await NodeFSP.writeFile(NodePath.join(artifacts, output), loaded, { mode: 0o600 });
      sources.push({
        path,
        sha256: NodeCrypto.createHash("sha256").update(source).digest("hex"),
        loadedSha256: NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(NodePath.join(runtime, output)))
          .digest("hex"),
      });
    }
    await NodeFSP.writeFile(
      NodePath.join(artifacts, "sources.json"),
      JSON.stringify(
        {
          loader:
            "node:module NodeModule.stripTypeScriptTypes(mode=strip); channels relative import only",
          sources,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await NodeFSP.writeFile(
      NodePath.join(runtime, "windowsFixture.mjs"),
      await NodeFSP.readFile(new URL("./windowsFixture.mjs", import.meta.url)),
      { mode: 0o600 },
    );
    const log = await NodeFSP.open(NodePath.join(artifacts, "electron.log"), "wx", 0o600);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron: string = NodeModule.createRequire(import.meta.url)("electron");
    const child = NodeChildProcess.spawn(
      electron,
      [
        NodePath.join(runtime, "windowsFixture.mjs"),
        NodePath.resolve(artifacts),
        String(sessionId),
      ],
      {
        env,
        stdio: ["ignore", log.fd, log.fd],
        windowsHide: false,
      },
    );
    cleanup = async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = NodeEvents.once(child, "exit");
        child.kill();
        await exited;
      }
      await log.close();
      await NodeFSP.rm(runtime, { recursive: true, force: true });
    };
    const [code, signal] = await NodeEvents.once(child, "exit");
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(artifacts, "manifest.json"), "utf8"),
    );
    expect({ code, signal, status: manifest.status }, `Original capture: ${artifacts}`).toEqual({
      code: 0,
      signal: null,
      status: "captured-awaiting-pixel-review",
    });
    expect(manifest.stages).toHaveLength(3);
  },
);
