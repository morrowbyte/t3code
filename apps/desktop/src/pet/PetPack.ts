// @effect-diagnostics nodeBuiltinImport:off -- Native pet packs are bounded files copied into desktop-owned storage.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const integer = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const animation = Schema.Struct({
  row: integer(0, 7),
  frames: Schema.Literal(4),
  fps: Schema.Literal(6),
  loop: Schema.Literal(false),
}).annotate(strict);
const Pack = Schema.Struct({
  schema: Schema.Literal(1),
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(60),
    Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/),
    Schema.isPattern(/^[^\p{Bidi_Control}]+$/u),
  ),
  frameWidth: integer(64, 512),
  frameHeight: integer(64, 512),
  sheet: Schema.Literal("pet.png"),
  states: Schema.Struct({
    idle: animation,
    working: animation,
    reading: animation,
    lookingAway: animation,
    waiting: animation,
    attention: animation,
    success: animation,
    error: animation,
  }).annotate(strict),
}).annotate(strict);

const decodePack = Schema.decodeUnknownSync(Pack, { onExcessProperty: "error" });

async function boundedFile(filename: string, maximum: number) {
  const file = await NodeFSP.open(
    filename,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("invalid-pack");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error("invalid-pack");
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export function validatePetPack(manifest: unknown, png: Buffer) {
  const pack = decodePack(manifest);
  if (!pack.name.trim()) throw new Error("invalid-pack");
  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("invalid-pack");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    width !== pack.frameWidth * 4 ||
    height !== pack.frameHeight * 8 ||
    png[24] !== 8 ||
    png[25] !== 6 ||
    png[26] !== 0 ||
    png[27] !== 0 ||
    (png[28] !== 0 && png[28] !== 1)
  )
    throw new Error("invalid-pack");
  for (const [row, state] of Object.values(pack.states).entries()) {
    if (state.row !== row) throw new Error("invalid-pack");
  }
  return pack;
}

export async function importPetPack(
  source: string,
  directory: string,
  decodesImage: (png: Buffer, width: number, height: number) => boolean,
) {
  if (!NodePath.isAbsolute(source) || (await NodeFSP.realpath(source)) !== NodePath.resolve(source))
    throw new Error("invalid-pack");
  const entries = await NodeFSP.readdir(source);
  if (entries.length !== 2 || !entries.includes("pet.json") || !entries.includes("pet.png"))
    throw new Error("invalid-pack");
  for (const filename of ["pet.json", "pet.png"]) {
    if (!(await NodeFSP.lstat(NodePath.join(source, filename))).isFile())
      throw new Error("invalid-pack");
  }
  const manifest = await boundedFile(NodePath.join(source, "pet.json"), 16_384);
  const png = await boundedFile(NodePath.join(source, "pet.png"), 16 * 1024 * 1024);
  const pack = validatePetPack(JSON.parse(manifest.toString("utf8")), png);
  if (!decodesImage(png, pack.frameWidth * 4, pack.frameHeight * 8))
    throw new Error("invalid-pack-image");
  const destination = NodePath.join(directory, `pack-${NodeCrypto.randomUUID()}`);
  await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.writeFile(NodePath.join(destination, "pet.json"), JSON.stringify(pack), {
      mode: 0o600,
    });
    await NodeFSP.writeFile(NodePath.join(destination, "pet.png"), png, { mode: 0o600 });
    return { path: await NodeFSP.realpath(destination), name: pack.name };
  } catch (error) {
    await NodeFSP.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
