// This fixed program runs as the main process of a bounded transient systemd service.
// The script is read from stdin; neither systemd nor this supervisor loads executable temp files.
export const supervisor = String.raw`
import os, select, signal, subprocess, sys, threading, time

def start_time(pid):
    with open('/proc/%d/stat' % pid, 'r') as f:
        return f.read().rsplit(') ', 1)[1].split()[19]

def watch(pid, expected):
    fd = os.pidfd_open(pid, 0)
    if start_time(pid) != expected:
        raise RuntimeError('caller identity changed')
    return fd

def stop_group(worker):
    try:
        os.killpg(worker.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

worker = None
try:
    wrapper, wrapper_start, parent, parent_start, timeout_ms, shell, receipt, control = sys.argv[1:]
    fds = [watch(int(wrapper), wrapper_start), watch(int(parent), parent_start)]
    poller = select.poll()
    for fd in fds:
        poller.register(fd, select.POLLIN)
    deadline = time.monotonic() + int(timeout_ms) / 1000
    payload = sys.stdin.buffer.read(262145)
    def cancelled():
        with open(control, 'r', encoding='ascii') as f:
            if f.read(4) != 'run':
                raise RuntimeError('stop channel invalid')
        try:
            os.stat(control + '.stop')
            return True
        except FileNotFoundError:
            return False
    if len(payload) > 262144:
        raise RuntimeError('caller gone or input too large')
    if cancelled() or poller.poll(0) or time.monotonic() >= deadline:
        os.write(1, ('\nT3_RESULT_' + receipt + ':stop:124\n').encode('ascii'))
        sys.exit(124)
    worker = subprocess.Popen(['sh'], executable=shell, stdin=subprocess.PIPE, start_new_session=True)
    def feed():
        try:
            worker.stdin.write(payload)
            worker.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
    threading.Thread(target=feed, daemon=True).start()
    while True:
        # WNOWAIT retains the worker PID until its entire process group is terminated.
        done = os.waitid(os.P_PID, worker.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if done:
            stop_group(worker)
            code = worker.wait()
            worker = None
            code = code if code >= 0 else 128 - code
            os.write(1, ('\nT3_RESULT_' + receipt + ':done:' + str(code) + '\n').encode('ascii'))
            sys.exit(code)
        remaining = deadline - time.monotonic()
        if remaining <= 0 or cancelled() or poller.poll(max(1, min(100, int(remaining * 1000)))):
            stop_group(worker)
            worker.wait()
            worker = None
            os.write(1, ('\nT3_RESULT_' + receipt + ':stop:124\n').encode('ascii'))
            sys.exit(124)
finally:
    if worker is not None:
        stop_group(worker)
        worker.wait()
`;

// The wrapper is the ProcessRunner child. Its PID survives exec into sudo, so interruption and
// host death are observable by pidfds even if sudo/systemd-run are reparented or the PID is reused.
export const wrapper = String.raw`
start_time() {
  IFS= read -r stat < "/proc/$1/stat" || exit 125
  stat=${"${stat##*) }"}
  set -- $stat
  shift 19
  printf '%s' "$1"
}
wrapper_start=$(start_time $$) || exit 125
sudo=$1
receipt=$9
set -- "$2" --unit="${"${11}"}" --quiet --wait --pipe --collect --no-ask-password --service-type=exec \
  --expand-environment=no --property="RuntimeMaxSec=$3" --property="TimeoutStartSec=$3" --property=KillMode=control-group \
  --property=TimeoutStopSec=1s --working-directory="$4" -- "$5" -I -c "$6" \
  "$$" "$wrapper_start" "${"${12}"}" "${"${13}"}" "$7" "$8" "$9" "${"${10}"}"
if ! "$sudo" -n -l -- "$@" >/dev/null; then
  printf 'T3_PREFLIGHT_%s:denied\n' "$receipt"
  exit 125
fi
# A worker can never forge the first line: it is emitted before sudo starts systemd-run.
printf 'T3_PREFLIGHT_%s:allowed\n' "$receipt" || exit 125
exec "$sudo" -n -- "$@"
`;
