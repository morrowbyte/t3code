#!/usr/bin/env bash
# Intent: Einen unveränderten Release-Split auf dem isolierten CI-Emulator starten
set -euo pipefail
umask 077

[[ $# -eq 4 ]] || { echo 'Usage: android-startup-smoke.sh <arm64-apk> <x86_64-apk> <evidence-dir> <source-sha>' >&2; exit 2; }
arm64_apk="$(realpath "$1")"
startup_apk="$(realpath "$2")"
evidence_dir="$(realpath -m "$3")"
source_sha="$4"
package_name=com.morrowbyte.t3code
serial="${ANDROID_SERIAL:-emulator-5554}"
[[ "${GITHUB_ACTIONS:-}" == true && "$serial" =~ ^emulator-[0-9]+$ ]] || { echo 'Only an isolated GitHub Actions emulator is allowed.' >&2; exit 1; }
mkdir -p "$evidence_dir"
adb_command=(adb -s "$serial")
[[ "$("${adb_command[@]}" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || { echo 'The selected target is not an emulator.' >&2; exit 1; }

# Invoked by the EXIT trap.
# shellcheck disable=SC2329
capture_evidence() {
  local status=$?
  trap - EXIT
  "${adb_command[@]}" logcat -d -v threadtime -t 5000 > "$evidence_dir/logcat.txt" 2>&1 || true
  python3 - "$evidence_dir/logcat.txt" <<'PYLOG'
from pathlib import Path
import sys
path = Path(sys.argv[1])
data = path.read_bytes()
if len(data) > 2 * 1024 * 1024:
    path.write_bytes(b'[Earlier logcat bytes omitted: 2 MiB capture limit]\n' + data[-2 * 1024 * 1024:])
PYLOG
  "${adb_command[@]}" shell dumpsys activity activities > "$evidence_dir/activity.txt" 2>&1 || true
  "${adb_command[@]}" exec-out screencap -p > "$evidence_dir/screenshot.png" 2>/dev/null || true
  printf '%s\n' "$status" > "$evidence_dir/exit.txt"
  exit "$status"
}
trap capture_evidence EXIT

python3 - "$arm64_apk" "$startup_apk" "$evidence_dir" "$source_sha" <<'PYBUNDLE'
import hashlib, json, sys, zipfile
from pathlib import Path
arm64, startup, evidence = map(Path, sys.argv[1:4])
def apk_data(path, abi):
    with zipfile.ZipFile(path) as archive:
        libraries = [name for name in archive.namelist() if name.startswith('lib/') and name.endswith('.so')]
        assert libraries and {name.split('/')[1] for name in libraries} == {abi}, 'Unexpected APK ABI'
        return archive.read('assets/index.android.bundle')
arm64_bundle = apk_data(arm64, 'arm64-v8a')
assert arm64_bundle == apk_data(startup, 'x86_64'), 'The emulator must run the exact shipping Hermes bundle'
digest = lambda path: hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
(evidence / 'input.json').write_text(json.dumps({
    'source': sys.argv[4], 'package': 'com.morrowbyte.t3code',
    'productionApkSha256': digest(arm64), 'startupApkSha256': digest(startup),
    'embeddedBundleSha256': hashlib.sha256(arm64_bundle).hexdigest(),
    'startupAbi': 'x86_64', 'shippingAbi': 'arm64-v8a', 'physicalDeviceAcceptance': False,
}, indent=2) + '\n')
PYBUNDLE

"${adb_command[@]}" shell getprop > "$evidence_dir/device-properties.txt"
[[ "$("${adb_command[@]}" shell getprop ro.build.version.sdk | tr -d '\r')" == 36 ]] || { echo 'Expected the Android 16 / API 36 emulator.' >&2; exit 1; }
"${adb_command[@]}" install -r "$startup_apk" > "$evidence_dir/install.txt" 2>&1
"${adb_command[@]}" logcat -c
"${adb_command[@]}" shell am start -W -n "$package_name/.MainActivity" > "$evidence_dir/launch.txt" 2>&1
grep -q '^Status: ok' "$evidence_dir/launch.txt" || { echo 'Android rejected the launcher activity.' >&2; exit 1; }

started_pid=""
ready_observations=0
startup_deadline=$((SECONDS + 90))
for ((attempt = 0; attempt < 30 && SECONDS < startup_deadline; attempt++)); do
  current_pid="$("${adb_command[@]}" shell pidof "$package_name" | tr -d '\r' || true)"
  [[ "$current_pid" =~ ^[0-9]+$ ]] || { echo 'The application process exited during startup.' >&2; exit 1; }
  if [[ -z "$started_pid" ]]; then
    started_pid="$current_pid"
  fi
  [[ "$current_pid" == "$started_pid" ]] || { echo 'The application process restarted during startup.' >&2; exit 1; }
  "${adb_command[@]}" logcat -d -v brief -t 3000 --pid="$started_pid" > "$evidence_dir/app-logcat.txt"
  if grep -Eiq 'FATAL EXCEPTION|Fatal signal|ReactNativeJS.*(ReferenceError|TypeError|SyntaxError|Invariant Violation|Error:)|\[runtime not ready\]|has not been registered|JavascriptException|Unable to load script' "$evidence_dir/app-logcat.txt"; then
    echo 'A native or JavaScript startup error was recorded.' >&2
    exit 1
  fi
  "${adb_command[@]}" shell dumpsys activity activities > "$evidence_dir/activity.txt"
  if timeout 12 "${adb_command[@]}" shell uiautomator dump /sdcard/crew-startup.xml > "$evidence_dir/ui-dump.txt" 2>&1; then
    "${adb_command[@]}" exec-out cat /sdcard/crew-startup.xml > "$evidence_dir/ui.xml"
    if python3 - "$evidence_dir/ui.xml" "$evidence_dir/activity.txt" <<'PYUI'
from pathlib import Path
import sys, xml.etree.ElementTree as ET
nodes = ET.parse(sys.argv[1]).getroot().iter('node')
ready = any(node.get('package') == 'com.morrowbyte.t3code' and
            (node.get('text') in {'No environments connected', 'Add environment'} or
             node.get('content-desc') == 'Add environment') for node in nodes)
activity = Path(sys.argv[2]).read_text()
resumed = any('com.morrowbyte.t3code/.MainActivity' in line and
              ('mResumedActivity' in line or 'topResumedActivity' in line) for line in activity.splitlines())
sys.exit(0 if ready and resumed else 1)
PYUI
    then
      ready_observations=$((ready_observations + 1))
      if [[ "$ready_observations" -ge 2 ]]; then
        python3 - "$evidence_dir" "$started_pid" <<'PYREADY'
from pathlib import Path
import json, os, sys
root = Path(sys.argv[1])
proof = json.loads((root / 'input.json').read_text())
proof.update(schemaVersion=1, status='passed', apiLevel=36, pid=int(sys.argv[2]),
             run=os.environ['GITHUB_RUN_ID'], attempt=os.environ['GITHUB_RUN_ATTEMPT'],
             launcherStarted=True, resumedActivity=True, uiBeyondSplash=True,
             stableProcess=True, startupErrors=False)
(root / 'startup.json').write_text(json.dumps(proof, indent=2) + '\n')
PYREADY
        echo 'Android 16 release startup passed: stable process and real application UI beyond splash.'
        exit 0
      fi
    else
      ready_observations=0
    fi
  fi
  sleep 2
done
echo 'The release did not show usable application UI beyond the splash screen.' >&2
exit 1
