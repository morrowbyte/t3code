// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local GitHub fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3"],
    ["preview", "1.2.4-preview.20261019.50"],
  ])("finds the newest %s release behind a full page of nightlies", async (channel, version) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
    const target = NodePath.join(root, "home/runtime/versions", version);
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const body =
        url.pathname === "/pingdotgg/t3code/releases/latest" &&
        request.headers.accept === "application/json"
          ? { tag_name: "v1.2.3" }
          : url.pathname === "/repos/pingdotgg/t3code/releases"
            ? { "1": nightlies, "2": [{ tag_name: `v${version}` }, { tag_name: "v1.2.3" }] }[
                url.searchParams.get("page") ?? ""
              ]
            : undefined;
      if (body === undefined) response.statusCode = 404;
      // The API pretty-prints and the installer reads it line by line.
      response.end(JSON.stringify(body ?? [], null, 2));
    });
    try {
      // An existing completed install isolates release resolution from archive downloads.
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const source = await NodeFSP.readFile(
        NodePath.resolve(import.meta.dirname, "install.sh"),
        "utf8",
      );
      const installer = NodePath.join(root, "install.sh");
      await NodeFSP.writeFile(installer, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
      const { code, output } = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", [installer], {
            env: {
              ...process.env,
              T3CODE_VERSION: "",
              T3CODE_CHANNEL: channel,
              T3CODE_HOME: NodePath.join(root, "home"),
              T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              // A wrong version must fail here instead of downloading a real release.
              T3CODE_RELEASE_BASE_URL: origin,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        },
      );
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed T3 Code ${version}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

const powershell = HostProcess.Platform.defaultValue() === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell =
  NodeChildProcess.spawnSync(powershell, [
    "-NoProfile",
    "-Command",
    "$PSVersionTable.PSVersion.Major",
  ]).status === 0;

it.skipIf(!hasPowerShell)(
  "binds Windows installer fallback to the original release receipt",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-receipt-"));
    const version = "1.2.3";
    const archive = `t3-${version}-win32-x64.zip`;
    const sha = "a".repeat(64);
    const original = `${"b".repeat(64)}  t3-${version}-linux-x64.tar.gz\n`;
    const windows = `${sha}  ${archive}\n`;
    const receipt = (
      sums: string,
      manifest: string,
      source = "c".repeat(40),
      tag = `v${version}`,
    ) => {
      const digests = sums
        .trimEnd()
        .split("\n")
        .map((line) => ({ name: line.slice(66), digest: `sha256:${line.slice(0, 64)}` }));
      digests.push({
        name: manifest,
        digest: `sha256:${NodeCrypto.createHash("sha256").update(sums).digest("hex")}`,
      });
      return `fork_release=${tag}\nsource_sha=${source}\ngithub_asset_digests=${JSON.stringify(digests)}\nartifact_sha256:\n${sums}`;
    };
    const valid: Record<string, string> = {
      SHA256SUMS: original,
      "SHA256SUMS-windows": windows,
      "RELEASE-RECEIPT.txt": receipt(original, "SHA256SUMS"),
      "RELEASE-RECEIPT-windows.txt": receipt(windows, "SHA256SUMS-windows"),
    };
    try {
      const source = await NodeFSP.readFile(new URL("./install.ps1", import.meta.url), "utf8");
      const functions = source.slice(
        source.indexOf("function Read-Checksums("),
        source.indexOf("if ($interactive) {\n  # Block characters"),
      );
      const script = NodePath.join(root, "check.ps1");
      await NodeFSP.writeFile(
        script,
        `param([string] $Root)
$ErrorActionPreference = "Stop"
$version = "${version}"
${functions}
function Fetch([string] $uri, [string] $destination) {
  if (-not $uri.StartsWith("https://fixture.invalid/v${version}/")) { throw "Wrong release URL" }
  Add-Content (Join-Path $Root "requests") $uri
  Copy-Item (Join-Path $Root ([IO.Path]::GetFileName($uri))) $destination -Force
}
try { Get-ArchiveChecksum "https://fixture.invalid/v${version}" "${archive}" (Join-Path $Root "stage") } catch { [Console]::Error.WriteLine($_); exit 1 }
`,
      );
      await NodeFSP.mkdir(NodePath.join(root, "stage"));
      const run = async (files: Record<string, string>) => {
        await NodeFSP.writeFile(NodePath.join(root, "requests"), "");
        for (const [name, content] of Object.entries(files)) {
          await NodeFSP.writeFile(NodePath.join(root, name), content);
        }
        await NodeFSP.writeFile(NodePath.join(root, "stage/SHA256SUMS"), files.SHA256SUMS);
        return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(powershell, ["-NoProfile", "-File", script, root]);
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
      };
      const good = await run(valid);
      expect(good.code, good.output).toBe(0);
      expect(good.output.trim()).toBe(sha);
      const preferred = await run({ ...valid, SHA256SUMS: windows });
      expect(preferred.code, preferred.output).toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(root, "requests"), "utf8")).toBe("");
      for (const [file, invalid, error] of [
        ["SHA256SUMS", "invalid\n", "Invalid"],
        ["SHA256SUMS", original + original, "Duplicate"],
        ["RELEASE-RECEIPT.txt", receipt(original, "SHA256SUMS", "bad"), "source_sha"],
        [
          "RELEASE-RECEIPT.txt",
          receipt(original, "SHA256SUMS", "c".repeat(40), "v9.9.9"),
          "fork_release",
        ],
        [
          "RELEASE-RECEIPT-windows.txt",
          receipt(windows, "SHA256SUMS-windows", "d".repeat(40)),
          "source_sha",
        ],
        [
          "RELEASE-RECEIPT-windows.txt",
          receipt(windows, "SHA256SUMS-windows", "c".repeat(40), "v9.9.9"),
          "fork_release",
        ],
        [
          "RELEASE-RECEIPT-windows.txt",
          valid["RELEASE-RECEIPT-windows.txt"] + "extra",
          "checksum block",
        ],
        [
          "RELEASE-RECEIPT-windows.txt",
          valid["RELEASE-RECEIPT-windows.txt"].replace(`sha256:${sha}`, `sha256:${"0".repeat(64)}`),
          "digest",
        ],
      ] as const) {
        const bad = await run({ ...valid, [file]: invalid });
        expect(bad.code, bad.output).toBe(1);
        expect(bad.output).toContain(error);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
