import { useState } from "react";
import * as Option from "effect/Option";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthGrantScope,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHostname, type ServerClientSessionRecord } from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionState,
  usePreparedConnection,
} from "~/state/session";
import type { EnvironmentPresentation } from "~/state/environments";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import {
  sortDesktopPairingLinks,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
} from "./ConnectionsSettings.logic";

const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

export function SavedEnvironmentAccess({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const session = useEnvironmentSessionState(environmentId);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const access = useEnvironmentQuery(
    canRead ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const createPairing = useAtomCommand(authEnvironment.createPairing, { reportFailure: false });
  const revokePairing = useAtomCommand(authEnvironment.revokePairing, { reportFailure: false });
  const revokeClient = useAtomCommand(authEnvironment.revokeClient, { reportFailure: false });
  const revokeOthers = useAtomCommand(authEnvironment.revokeOtherClients, { reportFailure: false });
  const [credentials, setCredentials] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [revokingPairingId, setRevokingPairingId] = useState<string | null>(null);
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = access.data?.type === "snapshot" ? access.data.payload : null;
  const pairingLinks = sortDesktopPairingLinks(
    (snapshot?.pairingLinks ?? []).map(toDesktopPairingLinkRecord),
  );
  const clients = sortDesktopClientSessions(
    (snapshot?.clientSessions ?? []).map(toDesktopClientSessionRecord),
  );
  const scopes = session.data?.authenticated
    ? (session.data.permissions ?? session.data.scopes ?? [])
    : [];
  const create = async (input: { label: string; scopes: ReadonlyArray<AuthGrantScope> }) => {
    const result = await createPairing({ environmentId, input });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const onCreated = (created: AuthPairingCredentialResult) => {
    setCredentials((current) => new Map(current).set(created.id, created.credential));
  };
  const onRevokePairing = async (id: string) => {
    if (!readEnvironmentScope(environmentId, AuthAccessWriteScope)) return;
    setRevokingPairingId(id);
    setError(null);
    try {
      const result = await revokePairing({ environmentId, input: id });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setCredentials((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke pairing link.");
    } finally {
      setRevokingPairingId(null);
    }
  };
  const onRevokeClient = async (sessionId: ServerClientSessionRecord["sessionId"]) => {
    if (!readEnvironmentScope(environmentId, AuthAccessWriteScope)) return;
    setRevokingClientId(sessionId);
    setError(null);
    try {
      const result = await revokeClient({ environmentId, input: sessionId });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke client.");
    } finally {
      setRevokingClientId(null);
    }
  };
  const onRevokeOthers = async () => {
    if (!readEnvironmentScope(environmentId, AuthAccessWriteScope)) return;
    if (
      !(await requestConfirmDialog(`Revoke all other clients on ${environment.label}?`, {
        variant: "destructive",
      }))
    )
      return;
    setRevokingOthers(true);
    setError(null);
    try {
      const result = await revokeOthers({ environmentId, input: null });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke other clients.");
    } finally {
      setRevokingOthers(false);
    }
  };
  const endpointUrl =
    environment.serverConfig?.directEndpoints?.find(
      (endpoint) => !isLoopbackHostname(new URL(endpoint.httpBaseUrl).hostname),
    )?.httpBaseUrl ?? prepared?.httpBaseUrl;
  return (
    <div className="mt-2 border-t border-border/50 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        <h3 className="text-sm font-medium">Authorized clients · {environment.label}</h3>
        {canWrite && prepared ? (
          <AuthorizedClientsHeaderAction
            environmentId={environmentId}
            createPairingCredential={create}
            delegatableScopes={scopes}
            onPairingLinkCreated={onCreated}
            clientSessions={snapshot ? clients : null}
            isRevokingOtherClients={revokingOthers}
            onRevokeOtherClients={() => void onRevokeOthers()}
          />
        ) : null}
      </div>
      {(error ?? access.error) ? (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error ?? access.error}
        </p>
      ) : null}
      {!canRead
        ? [...credentials].map(([id, credential]) => (
            <div key={id} className="px-4 py-2">
              <Input aria-label="One-time pairing code" readOnly value={credential} />
            </div>
          ))
        : null}
      {canRead ? (
        <PairingClientsList
          endpointUrl={endpointUrl}
          endpoints={EMPTY_ADVERTISED_ENDPOINTS}
          defaultEndpointKey={null}
          isLoading={access.isPending && snapshot === null}
          pairingLinks={pairingLinks}
          createdPairingCredentials={credentials}
          clientSessions={clients}
          revokingPairingLinkId={revokingPairingId}
          revokingClientSessionId={revokingClientId}
          onRevokePairingLink={(id) => void onRevokePairing(id)}
          onRevokeClientSession={(id) => void onRevokeClient(id)}
          canRevoke={canWrite}
        />
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {canWrite
            ? "This connection can create access links but cannot view authorized clients."
            : "This connection does not grant access management. Pair this device using a link with View access or Manage access permission."}
        </p>
      )}
    </div>
  );
}
