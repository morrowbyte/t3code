"""Windows SCM entry point; runs under the explicitly installed virtual service account."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import threading


def main():
    if os.name != "nt":
        raise RuntimeError("Windows SCM required")
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    class Status(ctypes.Structure):
        _fields_ = [(name, wintypes.DWORD) for name in ("serviceType", "state", "controls", "exitCode", "specificExitCode", "checkpoint", "waitHint")]
    control_type = ctypes.WINFUNCTYPE(wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p)
    main_type = ctypes.WINFUNCTYPE(None, wintypes.DWORD, ctypes.POINTER(wintypes.LPWSTR))
    class Entry(ctypes.Structure):
        _fields_ = [("name", wintypes.LPWSTR), ("main", main_type)]
    api.RegisterServiceCtrlHandlerExW.argtypes = [wintypes.LPCWSTR, control_type, ctypes.c_void_p]
    api.RegisterServiceCtrlHandlerExW.restype = wintypes.HANDLE
    api.SetServiceStatus.argtypes = [wintypes.HANDLE, ctypes.POINTER(Status)]
    api.SetServiceStatus.restype = wintypes.BOOL
    api.StartServiceCtrlDispatcherW.argtypes = [ctypes.POINTER(Entry)]
    api.StartServiceCtrlDispatcherW.restype = wintypes.BOOL
    stop = threading.Event()
    handle = None
    def status(state, code=0):
        value = Status(0x10, state, 5 if state == 4 else 0, code, 0, 0, 45000 if state in (2, 3) else 0)
        if not api.SetServiceStatus(handle, ctypes.byref(value)):
            raise ctypes.WinError(ctypes.get_last_error())
    @control_type
    def control(code, event, data, context):
        if code in (1, 5):
            stop.set()
        return 0
    @main_type
    def service_main(count, values):
        nonlocal handle
        handle = api.RegisterServiceCtrlHandlerExW("T3ApprovalWorker", control, None)
        if not handle:
            return
        process = None
        exit_code = 1
        try:
            status(2)
            Path(config["stopFile"]).unlink(missing_ok=True)
            log = Path(config["ledgerFile"]).parent / "service-worker.log"
            with open(log, "ab", buffering=0) as stream:
                process = subprocess.Popen([sys.executable, "-I", "-B", "-u", str(Path(__file__).with_name("worker.py")), "--config", args.config],
                    stdin=subprocess.DEVNULL, stdout=stream, stderr=stream,
                    env={key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}, close_fds=True)
                status(4)
                while process.poll() is None:
                    if stop.wait(1):
                        status(3)
                        Path(config["stopFile"]).write_text("stop", encoding="utf-8")
                        process.wait(timeout=40)
                        break
                exit_code = process.returncode
        except Exception as error:
            # Preserve an uncertain in-flight claim; never terminate another PID or retry it.
            log = Path(config["ledgerFile"]).parent / "service-errors.log"
            with open(log, "a", encoding="utf-8") as stream:
                stream.write(type(error).__name__ + "\n")
        finally:
            if process is not None and process.poll() is None:
                # SCM cannot safely report stopped while its child may still execute.
                process.wait()
            status(1, exit_code or 0)
    table = (Entry * 2)(Entry("T3ApprovalWorker", service_main), Entry(None, main_type()))
    if not api.StartServiceCtrlDispatcherW(table):
        raise ctypes.WinError(ctypes.get_last_error())


if __name__ == "__main__":
    main()
