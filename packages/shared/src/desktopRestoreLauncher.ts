const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function renderDesktopRestoreLauncher(input: {
  readonly artifactPath: string;
  readonly nixStorePath: string | null;
  readonly baseDir: string;
}) {
  const header = [
    "#!/bin/sh",
    "set -eu",
    "export ELECTRON_RUN_AS_NODE=1",
    `export T3CODE_HOME=${shellWord(input.baseDir)}`,
  ];
  if (input.nixStorePath !== null) {
    const runtime = `${input.nixStorePath}/lib/t3code-morrowbyte`;
    return [
      ...header,
      `exec ${shellWord(`${runtime}/t3code`)} ${shellWord(`${runtime}/resources/app.asar/apps/server/dist/bin.mjs`)} "$@"`,
      "",
    ].join("\n");
  }
  return [
    ...header,
    "unset APPIMAGE_EXTRACT_AND_RUN",
    `image=${shellWord(input.artifactPath)}`,
    `work=$(mktemp -d ${shellWord(`${input.baseDir}/runtime/desktop-restore/.mount.XXXXXX`)})`,
    '"$image" --appimage-mount >"$work/mount" 2>"$work/mount-error" &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null || true; wait "$mounter" 2>/dev/null || true; rm -rf -- "$work"' EXIT`,
    "trap 'exit 130' INT TERM",
    "mount=",
    "attempt=0",
    'while kill -0 "$mounter" 2>/dev/null && [ "$attempt" -lt 400 ]; do',
    '  mount=$(head -n 1 "$work/mount")',
    '  [ -d "$mount" ] && break',
    "  mount=",
    "  attempt=$((attempt + 1))",
    "  sleep 0.05",
    "done",
    // Extraction would materialize another complete app outside the retained-byte bound.
    'if [ -z "$mount" ]; then echo "Desktop restore requires a working AppImage FUSE mount." >&2; exit 2; fi',
    '"$mount/t3code" "$mount/resources/app.asar/apps/server/dist/bin.mjs" "$@"',
    "",
  ].join("\n");
}
