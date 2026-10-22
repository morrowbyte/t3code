# Approval worker operations

The requester submits immutable inputs to the existing approval-review API. The worker uses a separate execute-only session, claims once, checks the frozen source against `create_file_once.py`, and uses only its local SSH configuration. A second SSH invocation reads exactly the approved artifact. A durable SQLite attempt is committed before the claim; interrupted or ambiguous execution is never repeated.

## Operator configuration

Keep all configuration, tokens, keys, ledgers, logs and receipts outside Git. Give WinDev only its `approval-review:request` token. The worker token has only `approval-review:execute`. Neither identity is an approver.

The worker JSON requires `executionEnabled` (ship as `false`), `authorityUrl`, `tokenFile`, `ledgerFile`, `stopFile`, `requesterSubject`, `workerSubject`, `target` and `ssh`. `target` contains `verifiedTargetId`, one exact `allowedPath`, and SHA256 of the UTF-8 template. `ssh` contains absolute `executable`, `configFile`, `identityFile`, `knownHostsFile`, plus the fixed `host` (`user@host`). Use a dedicated empty SSH config and a privately retained known-hosts file with the independently checked host key. The program enforces strict host checking, batch mode, explicit identity, no agent/X11/port forwarding, and a fixed locally pinned Python program. Package contents never supply a shell command or SSH options.

HTTPS uses normal certificate verification. `allowPrivateHttp:true` explicitly permits a loopback or NetBird address for isolated development. Such a route retains the trust assumptions of its host/tunnel; a loopback label does not authenticate a remote authority against a compromised host user.

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
