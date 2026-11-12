import { useState } from "react";
import { View } from "react-native";
import {
  AgentPreferences,
  MAX_AGENT_PREFERENCES,
  ThreadId,
  type AgentPreference,
} from "@t3tools/contracts";
import { normalizeAgentPreference, replaceAgentPreference } from "@t3tools/shared/agentPreferences";
import * as Schema from "effect/Schema";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsRow } from "./SettingsRow";

const STATUS_LABELS = { active: "Active", inactive: "Inactive", completed: "Completed" } as const;
const isAgentPreferences = Schema.is(AgentPreferences);

export function AgentPreferencesSettings(props: {
  entries: ReadonlyArray<AgentPreference> | null;
  inheritedEntries: ReadonlyArray<AgentPreference>;
  projectSelected: boolean;
  disabled: boolean;
  onChange: (entries: ReadonlyArray<AgentPreference>) => void;
}) {
  const [draft, setDraft] = useState<AgentPreference | null>(null);
  const [removed, setRemoved] = useState<AgentPreference | null>(null);
  const [error, setError] = useState("");
  const entries = props.entries;
  const displayed = entries === null ? [] : [...entries, ...props.inheritedEntries];
  const existing = entries?.find((entry) => entry.key === draft?.key);
  return (
    <SettingsSection title="Confirmed agent preferences">
      {entries === null ? (
        <Text className="px-4 py-3 text-foreground-muted">
          Preferences differ. Select one target to edit.
        </Text>
      ) : (
        <View className="gap-3 pb-4">
          {displayed.length === 0 ? (
            <Text className="px-4 pt-3 text-foreground-muted">No confirmed preferences.</Text>
          ) : (
            displayed.map((entry) => (
              <View key={entry.key}>
                <SettingsRow
                  icon={undefined}
                  label={`${props.inheritedEntries.includes(entry) ? "Override: " : ""}${entry.key}`}
                  value={`${entry.text}\nSource: ${entry.source}\n${props.projectSelected && entries.some((own) => own.key === entry.key) ? "Project" : "Environment"} · ${STATUS_LABELS[entry.status]} · ${entry.appliesTo.kind === "task" ? `Thread: ${entry.appliesTo.threadId}` : "Ongoing"}`}
                  valuePosition="below"
                  disabled={
                    props.disabled ||
                    (props.inheritedEntries.includes(entry) &&
                      entries.length >= MAX_AGENT_PREFERENCES)
                  }
                  onPress={() => {
                    setDraft(entry);
                    setError("");
                  }}
                />
                {entry.replaces ? (
                  <View className="gap-1 px-4 pb-2">
                    <Text className="text-xs text-foreground-muted">
                      Replaced: {entry.replaces.text}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      Source: {entry.replaces.source}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))
          )}
          {removed ? (
            <View className="gap-2 px-4">
              <Text>Removed {removed.key}.</Text>
              <Button
                label="Undo"
                disabled={
                  props.disabled ||
                  entries.length >= MAX_AGENT_PREFERENCES ||
                  entries.some((entry) => entry.key === removed.key)
                }
                onPress={() => {
                  props.onChange([...entries, removed]);
                  setRemoved(null);
                }}
              />
            </View>
          ) : null}
          {draft === null ? (
            <View className="gap-2 px-4">
              <Button
                label="Add preference"
                disabled={props.disabled || entries.length >= MAX_AGENT_PREFERENCES}
                onPress={() => {
                  setDraft({
                    key: "",
                    text: "",
                    source: "",
                    appliesTo: { kind: "preference" },
                    status: "active",
                  });
                  setError("");
                }}
              />
              <Text className="text-xs text-foreground-muted">
                {entries.length}/{MAX_AGENT_PREFERENCES}
              </Text>
            </View>
          ) : (
            <View className="gap-3 px-4">
              <Text>Topic</Text>
              <AppTextInput
                accessibilityLabel="Preference topic"
                value={draft.key}
                maxLength={64}
                editable={!props.disabled && existing === undefined}
                onChangeText={(key) => setDraft({ ...draft, key })}
                className="min-h-12 rounded-lg bg-subtle px-3 text-foreground"
              />
              <Text>Preference</Text>
              <AppTextInput
                accessibilityLabel="Preference"
                value={draft.text}
                maxLength={500}
                multiline
                editable={!props.disabled}
                onChangeText={(text) => setDraft({ ...draft, text })}
                className="min-h-24 rounded-lg bg-subtle px-3 py-2 text-foreground"
              />
              <Text>Confirmation source</Text>
              <AppTextInput
                accessibilityLabel="Confirmation source"
                value={draft.source}
                maxLength={300}
                editable={!props.disabled}
                placeholder="Thread link or user message reference"
                onChangeText={(source) => setDraft({ ...draft, source })}
                className="min-h-12 rounded-lg bg-subtle px-3 text-foreground"
              />
              <Text>Applies to</Text>
              <ListChoiceRow
                label="Ongoing preference"
                selected={draft.appliesTo.kind === "preference"}
                disabled={props.disabled}
                onPress={() => setDraft({ ...draft, appliesTo: { kind: "preference" } })}
              />
              <ListChoiceRow
                label="One task only"
                selected={draft.appliesTo.kind === "task"}
                disabled={props.disabled}
                onPress={() =>
                  setDraft({
                    ...draft,
                    appliesTo:
                      draft.appliesTo.kind === "task"
                        ? draft.appliesTo
                        : { kind: "task", threadId: ThreadId.make("") },
                  })
                }
              />
              {draft.appliesTo.kind === "task" ? (
                <>
                  <Text>Task thread</Text>
                  <AppTextInput
                    accessibilityLabel="Task thread"
                    placeholder="Thread link or ID"
                    value={draft.appliesTo.threadId}
                    maxLength={512}
                    editable={!props.disabled}
                    onChangeText={(threadId) =>
                      setDraft({
                        ...draft,
                        appliesTo: { kind: "task", threadId: ThreadId.make(threadId) },
                      })
                    }
                    className="min-h-12 rounded-lg bg-subtle px-3 text-foreground"
                  />
                </>
              ) : null}
              <Text>Status</Text>
              {(["active", "inactive", "completed"] as const).map((status) => (
                <ListChoiceRow
                  key={status}
                  label={STATUS_LABELS[status]}
                  selected={draft.status === status}
                  disabled={props.disabled}
                  onPress={() => setDraft({ ...draft, status })}
                />
              ))}
              {error ? (
                <Text accessibilityRole="alert" className="text-danger">
                  {error}
                </Text>
              ) : null}
              <Button
                label="Save preference"
                tone="primary"
                disabled={props.disabled || JSON.stringify(existing) === JSON.stringify(draft)}
                onPress={() => {
                  const next = normalizeAgentPreference(draft);
                  const updated = replaceAgentPreference(entries, next);
                  if (!isAgentPreferences(updated)) {
                    setError(
                      "Enter a topic, preference and source within the field limits. A task decision needs its thread ID.",
                    );
                    return;
                  }
                  props.onChange(updated);
                  setError("");
                }}
              />
              <Button label="Close" onPress={() => setDraft(null)} />
              {existing ? (
                <Button
                  label="Remove"
                  tone="danger"
                  disabled={props.disabled}
                  onPress={() => {
                    props.onChange(entries.filter((entry) => entry.key !== existing.key));
                    setRemoved(existing);
                    setDraft(null);
                  }}
                />
              ) : null}
            </View>
          )}
        </View>
      )}
    </SettingsSection>
  );
}
