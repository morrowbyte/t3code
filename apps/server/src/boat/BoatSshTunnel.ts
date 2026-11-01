import { BoatError } from "@t3tools/contracts";
import { baseSshArgs, resolveSshCommand } from "@t3tools/ssh/command";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BoatApi } from "./BoatApi.ts";
import type { BoatLeaseAccess } from "./BoatService.ts";

const SshAccess = Schema.Struct({
  machineIp: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  sshEndpoint: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  sshUser: Schema.Literal("user"),
  hostKey: Schema.String,
});

const isBoatError = Schema.is(BoatError);
const decodeSshAccess = Schema.decodeUnknownEffect(SshAccess);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* Net.NetService;
  const api = yield* BoatApi;
  const ssh = yield* resolveSshCommand;
  const authorize = Effect.fn("BoatSshTunnel.authorize")(
    function* (lease: BoatLeaseAccess, token: Redacted.Redacted<string>) {
      yield* lease.check;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "crew-boat-ssh-" });
      yield* fs.chmod(directory, 0o700);
      const identity = path.join(directory, "identity");
      const generated = yield* spawner.exitCode(
        ChildProcess.make(
          ssh === "ssh.exe" ? "ssh-keygen.exe" : "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-f", identity, "-C", "crew-private-boat"],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        ),
      );
      if (generated !== 0) return yield* new BoatError({ category: "provider" });
      const key = (yield* fs.readFileString(`${identity}.pub`)).trim();
      yield* lease.check;
      const access = yield* api
        .request(token, `/sandboxes/${encodeURIComponent(lease.sandboxId)}/sshkey`, "POST", { key })
        .pipe(Effect.flatMap(decodeSshAccess));
      const endpoint = access.sshEndpoint?.match(/^([0-9.]+):([0-9]+)$/);
      const hostname = endpoint?.[1] ?? access.machineIp;
      const port = endpoint ? Number(endpoint[2]) : 22;
      if (
        (access.sshEndpoint !== null && !endpoint) ||
        !hostname ||
        !/^[0-9.]+$/.test(hostname) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(
          access.hostKey,
        )
      )
        return yield* new BoatError({ category: "provider" });
      const hostAlias = "crew-boat";
      const knownHosts = path.join(directory, "known_hosts");
      yield* fs.writeFileString(knownHosts, `${hostAlias} ${access.hostKey}\n`, { mode: 0o600 });
      yield* lease.check;
      return {
        hostname,
        port,
        username: "user",
        identityFile: identity,
        knownHostsFile: knownHosts,
        hostKeyAlias: hostAlias,
        check: lease.check,
        revoked: lease.revoked,
      } as const;
    },
    Effect.mapError((error) =>
      isBoatError(error) ? error : new BoatError({ category: "provider" }),
    ),
  );
  const open = Effect.fn("BoatSshTunnel.open")(
    function* (lease: BoatLeaseAccess, token: Redacted.Redacted<string>, remotePort: number) {
      yield* lease.check;
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
        return yield* new BoatError({ category: "conflict" });
      const binding = yield* authorize(lease, token);
      const localPort = yield* net.reserveLoopbackPort("127.0.0.1");
      yield* lease.check;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          ssh,
          [
            ...baseSshArgs(
              {
                alias: binding.hostname,
                hostname: binding.hostname,
                username: binding.username,
                port: binding.port,
              },
              { batchMode: "yes" },
            ),
            "-F",
            "none",
            "-i",
            binding.identityFile,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ControlPersist=no",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            `UserKnownHostsFile=${binding.knownHostsFile}`,
            "-o",
            "GlobalKnownHostsFile=none",
            "-o",
            `HostKeyAlias=${binding.hostKeyAlias}`,
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            "-T",
            "-L",
            `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
            `user@${binding.hostname}`,
            "sh",
            "-c",
            "'echo READY; exec cat >/dev/null'",
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
        ),
      );
      // Stdin ties the remote process to Crew's lifetime; the line follows forward setup.
      const ready = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.timeout("15 seconds"),
      );
      if (ready !== "READY") return yield* new BoatError({ category: "provider" });
      yield* lease.check;
      return { url: `http://127.0.0.1:${localPort}`, exited: child.exitCode.pipe(Effect.asVoid) };
    },
    Effect.mapError((error) =>
      isBoatError(error) ? error : new BoatError({ category: "provider" }),
    ),
  );
  return { authorize, open };
});
