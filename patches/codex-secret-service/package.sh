#!/usr/bin/env bash
# Intent: Package existing qualified native binaries while preserving the upstream helpers.
set -euo pipefail

if [[ $# -ne 3 ]]; then
    echo "Usage: $0 /original-0.163.0-package.tar.gz /compiled-binary-dir /output.tar.gz" >&2
    exit 2
fi

original_archive=$(realpath "$1")
binary_root=$(realpath "$2")
output_archive=$(realpath -m "$3")
patch_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test ! -e "$output_archive"
test "$(stat -c %s "$original_archive")" = 159424486
printf '%s  %s\n' 582646c6bf0561eb0de540f7fc85b9121b0091a826bc6e96830b7f1722122182 "$original_archive" | sha256sum -c -
test "$("$binary_root/codex" --version)" = 'codex-cli 0.163.0-morrowbyte.2'
test -x "$binary_root/codex-code-mode-host"

python3 - "$original_archive" "$binary_root" "$output_archive" "$patch_root" <<'PY'
import gzip
import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import tempfile

original, binaries, output, patches = map(pathlib.Path, sys.argv[1:])
def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()

output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='codex-package-', dir=output.parent) as directory:
    package = pathlib.Path(directory)
    with tarfile.open(original, 'r:gz') as archive:
        archive.extractall(package, filter='data')
    manifest_path = package / 'codex-package.json'
    manifest = json.loads(manifest_path.read_text())
    assert manifest['layoutVersion'] == 1 and manifest['version'] == '0.163.0'
    assert manifest['target'] == 'x86_64-unknown-linux-musl' and manifest['entrypoint'] == 'bin/codex'
    before = {str(path.relative_to(package)): digest(path) for path in package.rglob('*') if path.is_file()}
    for name in ('codex', 'codex-code-mode-host'):
        shutil.copy2(binaries / name, package / 'bin' / name)
    manifest['version'] = '0.163.0-morrowbyte.2'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    licenses = {
        'LICENSE.codex': 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc',
        'NOTICE.codex': '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915',
    }
    for name, expected in licenses.items():
        assert digest(patches / name) == expected
        assert not (package / name).exists()
        shutil.copyfile(patches / name, package / name)
        (package / name).chmod(0o644)
    replaced = {'bin/codex', 'bin/codex-code-mode-host', 'codex-package.json'}
    assert (package / 'codex-path/rg').is_file()
    for name, expected in before.items():
        if name not in replaced:
            assert digest(package / name) == expected, f'Changed upstream helper: {name}'
    with output.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', compresslevel=6, fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(package.rglob('*')):
                    assert not path.is_symlink(), f'Unexpected symlink: {path}'
                    info = archive.gettarinfo(str(path), str(path.relative_to(package)))
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    if path.is_file():
                        with path.open('rb') as stream:
                            archive.addfile(info, stream)
                    else:
                        archive.addfile(info)
    receipt = {
        'version': manifest['version'], 'target': manifest['target'],
        'sourceCommit': '83086188ae0614bd882818ff1aa23f3194962012',
        'licenses': licenses,
        'patches': {name: digest(patches / name) for name in ('0001-linux-noninteractive-keyring-reads.patch', '0002-noninteractive-refresh-save.patch')},
        'buildScripts': {name: digest(patches / name) for name in ('apply.sh', 'build.sh', 'setup-v8.sh', 'package.sh')},
        'sha256': digest(output), 'archiveBytes': output.stat().st_size,
        'binaries': {name: digest(binaries / name) for name in ('codex', 'codex-code-mode-host')},
        'preservedHelpers': {name: expected for name, expected in before.items() if name not in replaced},
    }
    output.with_suffix(output.suffix + '.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'preservedHelpers'}))
PY
