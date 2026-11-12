import { useId, useState } from "react";
import {
  AgentPreferences,
  MAX_AGENT_PREFERENCES,
  ThreadId,
  type AgentPreference,
} from "@t3tools/contracts";
import { normalizeAgentPreference, replaceAgentPreference } from "@t3tools/shared/agentPreferences";
import * as Schema from "effect/Schema";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const STATUS_LABELS = { active: "Active", inactive: "Inactive", completed: "Completed" } as const;
const isAgentPreferences = Schema.is(AgentPreferences);

export function AgentPreferencesSettings() {
  const { agentPreferences } = useScopedSettings();
  const { targets } = useSettingsScope();
  const update = useUpdateScopedSettings();
  const mixed = targets.some(
    (target) =>
      JSON.stringify(target.settings.agentPreferences) !== JSON.stringify(agentPreferences),
  );
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  return (
    <SettingsRow
      serverScoped
      settingKeys={["agentPreferences"]}
      {...searchableSetting("agent-preferences")}
    >
      <div className="max-w-2xl py-3">
        {mixed ? (
          <p className="text-sm text-muted-foreground">
            Preferences differ. Select one target to edit.
          </p>
        ) : (
          <PreferenceEditor
            key={scopeKey}
            entries={agentPreferences}
            onChange={(entries) => update({ agentPreferences: entries })}
          />
        )}
      </div>
    </SettingsRow>
  );
}

function PreferenceEditor({
  entries,
  onChange,
}: {
  entries: ReadonlyArray<AgentPreference>;
  onChange: (entries: ReadonlyArray<AgentPreference>) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<AgentPreference | null>(null);
  const [removed, setRemoved] = useState<AgentPreference | null>(null);
  const [error, setError] = useState("");
  const edit = (entry: AgentPreference) => {
    setDraft(entry);
    setError("");
  };
  const existing = entries.find((entry) => entry.key === draft?.key);
  return (
    <div className="space-y-3">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No confirmed preferences.</p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.key} className="space-y-1 py-3 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{entry.key}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {STATUS_LABELS[entry.status]} ·{" "}
                    {entry.appliesTo.kind === "task" ? "One task" : "Ongoing"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${entry.key}`}
                    onClick={() => edit(entry)}
                  >
                    Edit
                  </Button>
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
              <p className="break-words text-xs text-muted-foreground">Source: {entry.source}</p>
              {entry.appliesTo.kind === "task" ? (
                <p className="break-all text-xs text-muted-foreground">
                  Thread: {entry.appliesTo.threadId}
                </p>
              ) : null}
              {entry.replaces ? (
                <details className="text-xs text-muted-foreground">
                  <summary>Replaced preference</summary>
                  <p className="whitespace-pre-wrap break-words">{entry.replaces.text}</p>
                  <p className="break-words">Source: {entry.replaces.source}</p>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {removed ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Removed {removed.key}.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={
              entries.length >= MAX_AGENT_PREFERENCES ||
              entries.some((entry) => entry.key === removed.key)
            }
            onClick={() => {
              onChange([...entries, removed]);
              setRemoved(null);
            }}
          >
            Undo
          </Button>
        </div>
      ) : null}
      {draft === null ? (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={entries.length >= MAX_AGENT_PREFERENCES}
            onClick={() =>
              edit({
                key: "",
                text: "",
                source: "",
                appliesTo: { kind: "preference" },
                status: "active",
              })
            }
          >
            Add preference
          </Button>
          <span className="text-xs text-muted-foreground">
            {entries.length}/{MAX_AGENT_PREFERENCES}
          </span>
        </div>
      ) : (
        <form
          className="space-y-3 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const next = normalizeAgentPreference(draft);
            const updated = replaceAgentPreference(entries, next);
            if (!isAgentPreferences(updated)) {
              setError(
                "Enter a topic, preference and source within the field limits. A task decision needs its thread ID.",
              );
              return;
            }
            onChange(updated);
            setError("");
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`${id}-topic`}>Topic</Label>
            <Input
              id={`${id}-topic`}
              value={draft.key}
              maxLength={64}
              required
              readOnly={existing !== undefined}
              onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-text`}>Preference</Label>
            <Textarea
              id={`${id}-text`}
              value={draft.text}
              maxLength={500}
              required
              rows={3}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-source`}>Confirmation source</Label>
            <Input
              id={`${id}-source`}
              value={draft.source}
              maxLength={300}
              required
              placeholder="Thread link or user message reference"
              onChange={(event) => setDraft({ ...draft, source: event.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-scope`}>Applies to</Label>
              <Select
                value={draft.appliesTo.kind}
                onValueChange={(kind) =>
                  setDraft({
                    ...draft,
                    appliesTo:
                      kind === "task"
                        ? { kind, threadId: ThreadId.make("") }
                        : { kind: "preference" },
                  })
                }
              >
                <SelectTrigger id={`${id}-scope`}>
                  <SelectValue>
                    {draft.appliesTo.kind === "task" ? "One task only" : "Ongoing preference"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="preference">Ongoing preference</SelectItem>
                  <SelectItem value="task">One task only</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-status`}>Status</Label>
              <Select
                value={draft.status}
                onValueChange={(status) => {
                  if (status === "active" || status === "inactive" || status === "completed")
                    setDraft({ ...draft, status });
                }}
              >
                <SelectTrigger id={`${id}-status`}>
                  <SelectValue>{STATUS_LABELS[draft.status]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
          {draft.appliesTo.kind === "task" ? (
            <div className="space-y-1">
              <Label htmlFor={`${id}-thread`}>Task thread</Label>
              <Input
                id={`${id}-thread`}
                value={draft.appliesTo.threadId}
                maxLength={512}
                required
                placeholder="Thread link or ID"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    appliesTo: { kind: "task", threadId: ThreadId.make(event.target.value) },
                  })
                }
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={JSON.stringify(existing) === JSON.stringify(draft)}
            >
              Save preference
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
              Close
            </Button>
            {existing ? (
              <Button
                size="sm"
                variant="ghost-destructive"
                onClick={() => {
                  onChange(entries.filter((entry) => entry.key !== existing.key));
                  setRemoved(existing);
                  setDraft(null);
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
