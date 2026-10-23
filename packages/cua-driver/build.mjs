import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { transformWithOxc } from "vite-plus";
// Generated ABI sources remain byte-identical to the pinned upstream release.
const root = import.meta.dirname;
const provenance = JSON.parse(
  await NodeFSP.readFile(NodePath.resolve(root, "upstream.json"), "utf8"),
);
for (const [file, hash] of Object.entries(provenance.files)) {
  const bytes = await NodeFSP.readFile(NodePath.resolve(root, file));
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== hash)
    throw Error(`Pinned Cua SDK source changed: ${file}`);
  if (!file.startsWith("src/") || !file.endsWith(".ts")) continue;
  const output = NodePath.resolve(root, "dist", file.slice(4).replace(/\.ts$/u, ".js"));
  await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
  const { code } = await transformWithOxc(bytes.toString("utf8"), NodePath.resolve(root, file), {
    target: "es2022",
  });
  await NodeFSP.writeFile(output, code);
}
