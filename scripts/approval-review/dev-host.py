"""Owned Windows dev runtime. A job object bounds teardown to this spawned process tree."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    if os.name != "nt":
        raise RuntimeError("Windows job objects required")
    import _winapi
    import msvcrt
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--targets")
    args = parser.parse_args()
    source, state = Path(args.source).resolve(), Path(args.state).resolve()
    state.mkdir(parents=True, exist_ok=True)
    lock_file = open(state/"launcher.lock", "a+b")
    lock_file.write(b"\0")
    lock_file.flush()
    lock_file.seek(0)
    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
    stop = state/"stop"
    stop.unlink(missing_ok=True)
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    class Basic(ctypes.Structure):
        _fields_ = [("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong), ("flags", wintypes.DWORD),
            ("minWorkingSet", ctypes.c_size_t), ("maxWorkingSet", ctypes.c_size_t), ("activeLimit", wintypes.DWORD),
            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", ctypes.c_ulonglong*6), ("processMemory", ctypes.c_size_t),
            ("jobMemory", ctypes.c_size_t), ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t)]
    api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    api.CreateJobObjectW.restype = wintypes.HANDLE
    api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    api.ResumeThread.argtypes = [wintypes.HANDLE]
    api.ResumeThread.restype = wintypes.DWORD
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    job = api.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    process = thread = None
    try:
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not api.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        command = [args.node, str(source/"scripts/dev-runner.ts"), "dev", "--host", "0.0.0.0", "--port", "43879", "--home-dir", str(state/"home")]
        environment = {key: value for key, value in os.environ.items() if not key.startswith(("T3", "VITE_HTTP_URL", "VITE_WS_URL"))}
        path_key = next((key for key in environment if key.upper() == "PATH"), "PATH")
        environment[path_key] = str(source/"node_modules/.bin") + os.pathsep + environment.get(path_key, "")
        if args.targets:
            # Only an explicitly selected private operator policy reaches the isolated server.
            environment["T3CODE_APPROVAL_REVIEW_TARGETS"] = Path(args.targets).read_text(encoding="utf-8-sig")
        with open(state/"original.log", "ab", buffering=0) as output, open(os.devnull, "rb") as input_file:
            out_handle, in_handle = msvcrt.get_osfhandle(output.fileno()), msvcrt.get_osfhandle(input_file.fileno())
            os.set_handle_inheritable(out_handle, True)
            os.set_handle_inheritable(in_handle, True)
            startup = subprocess.STARTUPINFO()
            startup.dwFlags = subprocess.STARTF_USESTDHANDLES
            startup.hStdInput, startup.hStdOutput, startup.hStdError = in_handle, out_handle, out_handle
            startup.lpAttributeList = {"handle_list": [in_handle, out_handle]}
            process, thread, pid, tid = _winapi.CreateProcess(None, subprocess.list2cmdline(command), None, None,
                True, 0x08000004, environment, str(source), startup)
            if not api.AssignProcessToJobObject(job, process):
                _winapi.TerminateProcess(process, 1)  # This exact child is still suspended.
                raise ctypes.WinError(ctypes.get_last_error())
            if api.ResumeThread(thread) == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
            (state/"process.json").write_text(json.dumps({"launcherPid": os.getpid(), "pid": pid,
                "source": str(source), "home": str(state/"home"), "command": command}), encoding="utf-8")
            while not stop.exists() and _winapi.WaitForSingleObject(process, 500) == _winapi.WAIT_TIMEOUT:
                pass
    finally:
        # Only the assigned tree is terminated, including a partially started dev runner.
        api.CloseHandle(job)
        if thread is not None:
            _winapi.CloseHandle(thread)
        if process is not None:
            _winapi.CloseHandle(process)
        lock_file.close()


if __name__ == "__main__":
    main()
