import { useAtomValue } from "@effect/atom-react";
import type { ProjectFeatureTiming as TimingFeed } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentSessionState, usePreparedConnection } from "../../state/session";
import { readProjectFeatureTiming } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function duration(ms: number | null) {
  if (ms === null) return "Unavailable";
  if (ms === 0) return "0m";
  if (ms < 60_000) return "< 1m";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours
      ? `${hours}h ${minutes % 60}m`
      : `${minutes}m`;
}
const date = (at: number | null) => (at === null ? "Unavailable" : new Date(at).toLocaleString());

export function ProjectFeatureTiming({ member }: { member: SidebarProjectGroupMember }) {
  const allowed = useAtomValue(readProjectFeatureTiming.permissionAtom(member.environmentId));
  const environment = useEnvironment(member.environmentId);
  const connection = usePreparedConnection(member.environmentId);
  const connectionState = environment?.connection;
  const session = useEnvironmentSessionState(member.environmentId).data;
  const connected = connectionState?.phase === "connected";
  const read = useAtomCommand(readProjectFeatureTiming, { reportFailure: false });
  const [revision, refresh] = useState(0);
  const [result, setResult] = useState<{
    connection: typeof connection;
    connectionState: typeof connectionState;
    session: typeof session;
    revision: number;
    feed: TimingFeed | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads remote feature timing for the active authorized session and rejects completions after that session changes.
  useEffect(() => {
    if (!allowed || !connected) return;
    let active = true;
    void read({ environmentId: member.environmentId, input: { projectId: member.id } }).then(
      (result) => {
        if (active)
          setResult({
            connection,
            connectionState,
            session,
            revision,
            feed:
              result._tag === "Success" && result.value.projectId === member.id
                ? result.value
                : null,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [
    allowed,
    connected,
    connection,
    connectionState,
    session,
    member.environmentId,
    member.id,
    read,
    revision,
  ]);
  const current =
    result !== null &&
    result.connection === connection &&
    result.connectionState === connectionState &&
    result.session === session &&
    result.revision === revision
      ? result
      : null;
  const feed = allowed && connected ? current?.feed : null;
  const features = feed?.coverage === "complete" ? feed.features : [];
  const status = !allowed
    ? "This connection cannot read feature history."
    : !connected
      ? "Connect this environment to read feature history."
      : !current
        ? "Reading feature history…"
        : !feed
          ? "Feature history could not be read. Retry after reconnecting."
          : feed.coverage === "no_feature_history"
            ? "No recorded features."
            : feed.coverage === "unavailable"
              ? "Feature history is unavailable. Retry after reconnecting."
              : feed.coverage === "incomplete"
                ? "Feature history is incomplete. Timing unavailable."
                : null;
  return (
    <SettingsSection title="Feature time overview">
      <SettingsRow
        title={member.environmentLabel ?? "This environment"}
        description={member.workspaceRoot}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || !connected}
            onClick={() => refresh((n) => n + 1)}
          >
            Refresh
          </Button>
        }
      />
      {status ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4" role="status">
          {status}
        </p>
      ) : null}
      {feed?.coverage === "complete" ? (
        <details className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <summary className="cursor-pointer">Timing details</summary>
          <p className="pt-2">
            Observed as of {new Date(feed.asOf).toLocaleString()}. Calendar time includes waiting.
            Waits and phases cover recorded intervals only; unrecorded history and active
            development effort are unavailable. Reason totals can overlap; total waiting counts each
            interval once. Feature-to-release mapping is unavailable. Published or installed
            releases do not establish acceptance. Run duration includes waits; it does not measure
            effort, human work hours, feature completion, or a future ETA.
          </p>
        </details>
      ) : null}
      {features.map((feature) => (
        <SettingsRow
          key={feature.featureId}
          title={feature.title}
          description={
            feature.state === "accepted"
              ? "Accepted on every recorded target"
              : feature.state === "reopened"
                ? "Reopened"
                : "In development · acceptance unverified"
          }
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 py-2 text-sm sm:grid-cols-2">
            {[
              ["Recorded since", new Date(feature.registeredAt).toLocaleString()],
              [
                "Original estimate",
                feature.originalEstimate
                  ? `${duration(feature.originalEstimate.minimumMs)}–${duration(feature.originalEstimate.maximumMs)} · ${feature.originalEstimate.confidence} confidence, uncalibrated`
                  : "Unavailable",
              ],
              ["Calendar time since intake", duration(feature.elapsedFromIntakeMs)],
              ["Calendar time since first observed run start", duration(feature.elapsedFromWorkMs)],
              ["Observed waiting (no overlap)", duration(feature.waitMs)],
              ["First usable acceptance", date(feature.firstAcceptedAt)],
              ["Latest accepted completion", date(feature.latestCompletionAt)],
              ["Reopenings", String(feature.reopenCount)],
              ["Linked runs", String(feature.runCount)],
              [
                "Observed completed run duration",
                feature.observedRunTiming
                  ? `n = ${feature.observedRunTiming.sampleSize} · median ${duration(feature.observedRunTiming.medianMs)} · range ${duration(feature.observedRunTiming.minimumMs)}–${duration(feature.observedRunTiming.maximumMs)}${feature.observedRunTiming.sampleSize < 5 ? " · Small sample, uncertain" : ""}`
                  : "Unavailable",
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="pb-2 text-xs text-muted-foreground">Includes waits · Not effort or ETA</p>
          {feature.waitReasons.length ? (
            <p className="pb-2 text-xs text-muted-foreground">
              Observed waits:{" "}
              {feature.waitReasons.map((w) => `${w.reason}: ${duration(w.ms)}`).join(" · ")}
            </p>
          ) : null}
          <p className="pb-2 text-xs text-muted-foreground">
            Recorded phases:{" "}
            {feature.phases.length
              ? feature.phases.map((p) => `${p.phase}: ${duration(p.ms)}`).join(" · ")
              : "Unavailable"}
          </p>
          <ul className="space-y-2 pb-2 text-sm">
            {feature.targets.map((target) => (
              <li key={target.id}>
                <span>
                  {target.label}:{" "}
                  {target.acceptedVersion
                    ? `${target.reopened ? "Reopened · previously accepted" : "Accepted"} ${target.acceptedVersion}`
                    : target.reopened
                      ? "Reopened · accepted version unavailable"
                      : "Acceptance unverified"}
                </span>
                {target.evidence ? (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Acceptance details</summary>
                    <p>
                      User acceptance via {target.source}, {date(target.acceptedAt)} · message{" "}
                      {target.evidence.messageId} in thread {target.evidence.threadId}
                    </p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          <details className="pb-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Recorded history</summary>
            <ol className="mt-2 space-y-1">
              {feature.records.map((record) => (
                <li key={record.sequence}>
                  {new Date(record.at).toLocaleString()} · {record.type.replaceAll("_", " ")}
                  {record.reason ? ` · ${record.reason}` : ""}
                </li>
              ))}
            </ol>
          </details>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
