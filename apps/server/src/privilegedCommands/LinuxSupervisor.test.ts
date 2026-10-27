import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Runs a real unprivileged subprocess fixture outside Effect's test clock.
import * as NodeChildProcess from "node:child_process";
import { supervisor, wrapper } from "./LinuxSupervisor.ts";

describe("Linux supervisor", () => {
  it.live("rejects before launching the service when sudo preflight fails", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux" || process.getuid?.() === 0) return;
      const result = NodeChildProcess.spawnSync(
        "/bin/sh",
        [
          "-c",
          wrapper,
          "wrapper",
          "/bin/false",
          "/no-service-launcher",
          "1s",
          "/",
          "/python3",
          "fixed-code",
          "1000",
          "/bin/sh",
          "receipt",
          "/tmp/control",
          "test-unit.service",
          String(process.pid),
          "12345",
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(125);
      expect(result.stdout).toBe("T3_PREFLIGHT_receipt:denied\n");
    }),
  );
  // This exercises the real pidfd and process-group behavior without sudo or systemd.
  it.live("passes the real wrapper and host identities to the service launcher", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux" || process.getuid?.() === 0) return;
      const result = NodeChildProcess.spawnSync(
        "/bin/sh",
        [
          "-c",
          wrapper,
          "wrapper",
          "echo",
          "/systemd-run",
          "1s",
          "/",
          "/python3",
          "fixed-code",
          "1000",
          "/bin/sh",
          "receipt",
          "/tmp/control",
          "test-unit.service",
          String(process.pid),
          "12345",
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const identities = result.stdout.trim().split(/\s+/).slice(-8);
      expect(identities[0]).toMatch(/^\d+$/);
      expect(identities[1]).toMatch(/^\d+$/);
      expect(identities[2]).toBe(String(process.pid));
      expect(identities[3]).toBe("12345");
      expect(identities.slice(4)).toEqual(["1000", "/bin/sh", "receipt", "/tmp/control"]);
    }),
  );

  it.live("stops the worker and its background process on deadline and wrapper death", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux" || process.getuid?.() === 0) return;
      const harness = String.raw`
import base64, os, subprocess, sys, tempfile
def start(pid):
    with open('/proc/%d/stat' % pid) as f: return f.read().rsplit(') ', 1)[1].split()[19]
def alive(pid):
    try:
        with open('/proc/%d/stat' % pid) as f: return f.read().rsplit(') ', 1)[1].split()[0] != 'Z'
    except FileNotFoundError: return False
wrapper=subprocess.Popen(['sleep','30'])
control=tempfile.NamedTemporaryFile(mode='w',encoding='ascii')
control.write('run'); control.flush()
try:
    code=base64.b64decode(sys.argv[1]).decode()
    dead=subprocess.Popen(['sleep','30']); dead_start=start(dead.pid); dead.kill(); dead.wait()
    p=subprocess.Popen([sys.executable,'-I','-c',code,str(wrapper.pid),start(wrapper.pid),str(dead.pid),dead_start,'10000','/bin/sh','receipt',control.name],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    out,err=p.communicate(b'echo must-not-run\n',timeout=5)
    assert p.returncode != 0 and b'must-not-run' not in out, (p.returncode,out,err)
    p=subprocess.Popen([sys.executable,'-I','-c',code,str(wrapper.pid),start(wrapper.pid),str(os.getpid()),start(os.getpid()),'250','/bin/sh','receipt',control.name],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    out,err=p.communicate(b'sleep 30 & echo $!; wait\n',timeout=5)
    child=int(out.splitlines()[0])
    assert p.returncode == 124 and not alive(child), (p.returncode,child,err)
    p=subprocess.Popen([sys.executable,'-I','-c',code,str(wrapper.pid),start(wrapper.pid),str(os.getpid()),start(os.getpid()),'10000','/bin/sh','receipt',control.name],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    p.stdin.write(b'sleep 30 & echo $!; wait\n'); p.stdin.close(); p.stdin=None
    child=int(p.stdout.readline().strip())
    wrapper.kill(); wrapper.wait()
    out,err=p.communicate(timeout=5)
    assert p.returncode == 124 and not alive(child), (p.returncode,child,err)
finally:
    if wrapper.poll() is None: wrapper.kill(); wrapper.wait()
`;
      const result = NodeChildProcess.spawnSync(
        "python3",
        ["-I", "-c", harness, Buffer.from(supervisor).toString("base64")],
        { encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }),
  );
});
