# Approval worker operations

The requester submits immutable inputs to the existing approval-review API. The worker uses a separate execute-only session, claims once, checks the frozen source against `create_file_once.py`, and uses only its local SSH configuration. A second SSH invocation reads exactly the approved artifact. A durable SQLite attempt is committed before the claim; interrupted or ambiguous execution is never repeated.

## Operator configuration

Keep all configuration, tokens, keys, ledgers, logs and receipts outside Git. Give WinDev only its `approval-review:request` token. The worker token has only `approval-review:execute`. Neither identity is an approver.

The worker JSON requires `executionEnabled` (ship as `false`), `authorityUrl`, `tokenFile`, `ledgerFile`, `stopFile`, `requesterSubject`, `workerSubject`, `target` and `ssh`. `target` contains `verifiedTargetId`, one exact `allowedPath`, and SHA256 of the UTF-8 template. `ssh` contains absolute `executable`, `configFile`, `identityFile`, `knownHostsFile`, plus the fixed `host` (`user@host`). Use a dedicated empty SSH config and a privately retained known-hosts file with the independently checked host key. The program enforces strict host checking, batch mode, explicit identity, no agent/X11/port forwarding, and a fixed locally pinned Python program. Package contents never supply a shell command or SSH options.

HTTPS uses normal certificate verification. `allowPrivateHttp:true` explicitly permits a literal loopback, NetBird or RFC1918 IPv4 address for isolated development. Such a route retains the trust assumptions of its host/tunnel; a loopback label does not authenticate a remote authority against a compromised host user.

## Start, restart and stop

For an owned development process on Windows PowerShell 7.5 or newer:

```powershell
./operations.ps1 -Action start -Config C:\owned\worker.json -Python C:\runtime\python.exe
./operations.ps1 -Action status -Config C:\owned\worker.json -Python C:\runtime\python.exe
./operations.ps1 -Action restart -Config C:\owned\worker.json -Python C:\runtime\python.exe
./operations.ps1 -Action stop -Config C:\owned\worker.json -Python C:\runtime\python.exe
```

The spawn receipt retains PID, start time, executable and original log paths. Stop writes the worker's own stop file and waits; it never kills a process by name. `register` creates a uniquely named current-user logon task after verifying that the name is unused. `unregister` verifies its action/config identity, removes only that task and requests stop. A logon task is not an unattended service or a separate OS identity.

For the separate Windows service, the owner runs `install-service.ps1 -Action install` in an elevated PowerShell, supplying `RuntimeSource` (a complete standalone Python base), `ConfigSource`, `TokenSource`, `KeySource` and `KnownHostsSource`. It refuses an existing service/root and requires `executionEnabled:false`. It creates only `T3ApprovalWorker`, running as `NT SERVICE\T3ApprovalWorker`, under `C:\ProgramData\T3ApprovalWorker`. SYSTEM/Administrators control the protected root; the service can read runtime/config/key and modify only its state subtree. No password or new administrator membership is created. `start`, `status`, `stop`, `restart` and `rollback` use the same script. Rollback verifies service identity, stops and deletes only this service, and retains protected keys/ledger/receipts for deliberate audit. It does not delete an original key or alter an existing management connection. Automatic startup should be enabled only after an observed service restart and the owner's acceptance of the remaining gates.

Installing a protected copy of an existing SSH key does not remove the original user's access to that key. Existing broad peer credentials, server-mediated file reads/terminals/thread starts, same-user provider rights and original SSH rights remain separate gates. Installation/UAC alone never authorizes enabling execution. Do not activate a real external target until its actual requesting context, authority transport and human session binding are qualified.

## Bind the real browser session

The owner uses normal pairing personally, then reads their own `GET /api/approval-review/identity`. No agent consumes this pairing link. The trusted operator runs:

```sh
python bind-approver.py --config /private/operator.json --session-id SESSION_ID --subject SUBJECT
python bind-approver.py --config /private/operator.json --session-id SESSION_ID --subject SUBJECT --activate
```

The two identity values are not secrets. The preconfigured operator JSON supplies `appRoot`, `node`, isolated `home`, `policyFile`, `environmentFile`, `unit`, and `verifiedTargetId`. The unit must already reference this owned EnvironmentFile. The script cross-checks the exact active browser session against the existing local auth CLI; a client label is never authority. The first invocation validates without writing. Activation locks and atomically replaces the owned policy/environment files, keeps a private original-policy backup, and restarts only that unit. Failure restores the prior files and attempts the original restart. A changed approver session invalidates old packages under the backend policy; create a fresh submission afterward. The script does not approve anything and cannot prove that an agent-created test browser represents a human.

## Request and evidence

On WinDev, use its existing Node runtime:

```powershell
node request.mjs C:\private\requester.json C:\owned\request.json C:\owned\new-receipt.json
```

Requester config contains `authorityUrl`, `tokenFile` and, for development only, `allowPrivateHttp`. The JSON package follows the server's submit contract. Save the original test prompt/start separately and supply `originalTestPromptAt` and `promptTimestampProvenance` when known. The client exclusively creates the result and `new-receipt.json.trace.jsonl`, recording script start, known/unknown prompt time, action data read, local input hash, HTTP start/response, server package hash and errors. The local input SHA256 is distinct from the server-generated review package hash. These script timings do not measure model time or user-prompt-to-review latency. Never claim a VM script is an app-bound agent run.

One process holds an OS lock on the ledger. After a lost claim response, restart reads the server's claim state and reports `unknown` for its own uncertain claim without executing. Identical lost receipts are retried unchanged. A definitively unclaimed/other-owned attempt is locally abandoned; a fresh submission is required. Never erase the ledger to retry a consumed claim. A transport failure after exclusive file creation can leave a partial file; report unknown and inspect the exact approved path before any new human decision.

Focused checks: `python -B worker.test.py` on the Windows worker (POSIX target cases skip there) and on a POSIX host with the owned worktree under protected parents. `audit-context.ps1` records only process-token metadata, boolean File.Open results and original DACLs. It never reads credential bytes or changes existing ACLs. The installer/service require a real elevated owner-run validation; source and parser checks are not service acceptance.

## WinDev identity boundary (owner action prepared)

The existing unrestricted WinDev provider can open six broad peer credential files. No ACL mutation or service installation on Blain closes that path. Keep `executionEnabled:false`. Do not reuse the existing user's profile, provider auth, broad peer tokens or SSH keys in the new requester context.

An owner may run `requester-context.ps1 -Action install -NodeSource <standalone-node.exe> -CodexSource <standalone-codex.exe> -RequestTokenSource <request-only-token>` in an elevated WinDev PowerShell. This explicit UAC step creates only the standard local account `T3ApprovalRequester` and `C:\ProgramData\T3ApprovalRequester`, without administrator or CodexSandboxUsers membership. It copies public executables and the narrow requester token, leaves all existing accounts/profiles/ACLs untouched, and prompts privately for the new account's password. Verify the input token's sole scope through the isolated authority's local auth administration before installation; the script cannot infer token scopes from its bytes.

The owner signs into that account personally (or uses `runas /profile /user:.\T3ApprovalRequester pwsh`), supplying the password in the native prompt. No agent supplies it. In this new non-elevated console, run the copied script with `-Action verify -ForbiddenPathsFile <private-path-list.json>` containing the six inventoried existing credential paths and any additional management/provider secrets. The check opens and closes each file without reading bytes; missing files and ambiguous failures fail closed. Then audit the actual new Codex provider/tool process with `audit-context.ps1`, and verify that server-mediated file/terminal/thread/fleet operations cannot recover broad credentials. This prepared account step has not been executed and is not isolation evidence.

Codex needs its own personal login in the new profile; do not copy the old auth directory. Public executable copies may require their normal adjacent runtime files on a particular CLI distribution; qualify `node --version` and `codex --version` there before any model run. Create requester config/package/receipts only in the new workspace. No extra T3 server/provider implementation is installed. Stop the owned CLI normally, sign out, then owner-elevated `requester-context.ps1 -Action rollback` removes only the SID-bound account after checking sessions. Files and the new profile remain for deliberate cleanup; existing user profiles and credentials are never removed. The protected progress marker records the new SID before group/ACL/runtime/token operations; a later copy failure remains rollbackable. If that early SID write fails, only this invocation's newly returned SID is disabled and removed after confirming no sessions; uncertain session inspection prevents removal. An interrupted empty-root stage retains its marker and never removes a name-matched account.

## Independent operator check

The worker's second SSH call is **worker readback through the same key**, not an independent reader. `operator-readback.py --config <private-operator.json> --approved-action <frozen-action.json> --output <new-check.json>` prepares a separate, artifact-limited operator check. Its protected configuration pins the exact target/path/template, strict known-hosts file, `operatorKeyFingerprint`, distinct `workerKeyFingerprint`, and `sshKeygen` executable. It rejects the worker's key, sends only the local pinned template's read operation, verifies exact content/mode/ownership through that program, and never sends an authority receipt. Keep its config/key outside the VM and worker service. It requires an already authorized separate SSH identity; no such rights have been provisioned or exercised here. Obtain the action from the independently verified approved package. This check does not approve a package or prove that a human reviewed it.

## Isolated Windows authority/dev fallback

Use the integrated app pin `3d248672f44b57e6d9288eb7ec16704c2d70844a` or a qualified successor: earlier revisions cancel external pending requests during provider recovery. Keep this source checkout and home separate from the installed desktop and the user's existing profile. A sparse checkout excluding only `.repos`, local `core.longpaths=true` and `core.autocrlf=false` avoid vendored-reference path limits and fixture byte changes. Verify all eight fixture hashes against `bundle.metadata.json` after transfer. Install only pinned root, scripts, server and web dev dependencies; this is a development runtime, not a product bundle.

`dev-host.py` starts only this source's dev runner with API port 43879 and its own `state/home`. Its Windows job object owns precisely the suspended child and descendants; closing that job stops that tree. The launcher adds only this checkout's `node_modules/.bin` to its process PATH and strips ambient T3/baked-origin overrides. Startup logs remain private because they can contain pairing links. An exclusive launcher lock rejects a duplicate process. The web port derives from the checkout; retain the actual dev-runner value (5733 on the qualified Blain checkout).

Create one private dev config with absolute `source`, `state`, `python`, `node` and `targets` (private policy file) paths. Operate it with `dev-operations.ps1 -Action start|status|restart|stop -Config <private-dev-config.json>` in PowerShell 7.5+. It retains exact launcher PID/start-time/executable/config, refuses occupied ports, checks API readiness, and verifies environment identity across restart. `register` creates only the SID-bound current-user logon task `T3ApprovalDev20261022`; `unregister` validates its exact action before removing it and stopping this launcher. This is a logon task, not a boot service. Stop never kills an unrelated PID. Rollback is `unregister` (if registered), then retention of this owned checkout/home/logs for audit; no installed app or profile is changed. This user process is independent of the initiating terminal, but is not the separately provisioned Windows worker service or an OS isolation boundary.

The same `bind-approver.py` supports Windows. Its private operator config uses `appRoot`, `node`, `home`, `policyFile`, `verifiedTargetId`, optional `targetTemplateFile`, plus `powershell` and `devConfigFile`. The latter must reference exactly the same source/home/policy. The operator supplies only `--session-id` and `--subject`, obtained after personally pairing this authority's own localhost browser and reading `/api/approval-review/identity`. Run once without `--activate` to validate. Activation uses a Windows file lock, atomic policy replacement and private backup, restarts only that owned launcher, and restores the previous policy on failure. It requires an active, unexpired `browser-session-cookie` with `orchestration:operate`; a CLI-issued bearer or synthetic test identity is rejected. It never approves a request. A Nixy session is not a Blain session. Pairing, OS isolation, requester-token delivery and eventual external-action approval remain separate gates.

For the prepared Blain scratch package the personal entry is `./owner-entry.ps1 -Action pair` (run by the owner, never by an agent). It opens a newly labelled, ten-minute grant in the local default browser without printing its credential. Then `./owner-entry.ps1 -Action bind -SessionId <own-sessionId> -Subject <own-subject>` validates the two nonsecret fields; adding `-Activate` binds and restarts this authority. It loads the prepared private `operator-windows.json`, so no policy JSON or PID editing is required. Actual human pairing/binding remains unperformed. The owner must still separately approve the exact fresh package in Review after the OS/SSH/transport gates are resolved; pairing or binding is not that decision.
