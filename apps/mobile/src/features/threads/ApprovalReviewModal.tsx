/* oxlint-disable react/no-array-index-key -- This immutable package preserves supplied positions and duplicate entries without IDs. */
import { verifyReviewBundle, type ReviewBundle } from "@t3tools/client-runtime/approvalReview";
import type { ApprovalReviewAuthority } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

const SOURCE_PAGE_LINES = 100;

export function ApprovalReviewModal(props: {
  readonly bundle: ReviewBundle | null;
  readonly detail: string | undefined;
  readonly issue: string | null;
  readonly environmentLabel: string;
  readonly requestId: string;
  readonly authority: ApprovalReviewAuthority | undefined;
  readonly renderResponseControls: (verified: boolean) => ReactNode;
  readonly onVerification: (valid: boolean) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bodyScroll = useRef<ScrollView>(null);
  const [tab, setTab] = useState<"source" | "steps">("source");
  const [source, setSource] = useState({ path: props.bundle?.files[0]?.path ?? "", line: 1 });
  const [showOriginal, setShowOriginal] = useState(false);
  const onVerification = useEffectEvent(props.onVerification);
  const [verification, setVerification] = useState<Awaited<
    ReturnType<typeof verifyReviewBundle>
  > | null>(null);
  useEffect(() => {
    if (!props.bundle) return;
    let active = true;
    void verifyReviewBundle(props.bundle)
      .then((result) => {
        if (active) {
          onVerification(result.valid);
          setVerification(result);
        }
      })
      .catch(() => {
        if (active) {
          onVerification(false);
          setVerification({ valid: false, error: "Package integrity could not be checked." });
        }
      });
    return () => {
      active = false;
    };
  }, [props.bundle]);
  const file = props.bundle?.files.find((entry) => entry.path === source.path);
  const lines = useMemo(() => file?.content.split("\n") ?? [], [file]);
  const pageStart = Math.floor((source.line - 1) / SOURCE_PAGE_LINES) * SOURCE_PAGE_LINES;
  const pageEnd = Math.min(lines.length, pageStart + SOURCE_PAGE_LINES);
  const openSource = (path: string, line: number) => {
    setSource({ path, line });
    setTab("source");
    bodyScroll.current?.scrollTo({ y: 0, animated: false });
  };
  const { bundle } = props;

  return (
    <Modal visible presentationStyle="fullScreen" onRequestClose={props.onClose}>
      <View
        accessibilityViewIsModal
        className="flex-1 bg-screen"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="gap-2 border-b border-border p-4">
          <View className="flex-row items-center justify-between gap-3">
            <Text accessibilityRole="header" className="min-w-0 flex-1 font-t3-bold text-xl">
              Approval Review
            </Text>
            <Button label="Close review" tone="text" onPress={props.onClose} />
          </View>
          <Text className="font-t3-medium text-base">{bundle?.title ?? "Provider request"}</Text>
          <Text className="text-xs text-foreground-muted">{props.environmentLabel}</Text>
          {props.issue ? (
            <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
              {props.issue}
            </Text>
          ) : null}
          <View accessibilityRole="tablist" className="flex-row gap-2">
            {(["source", "steps"] as const).map((value) => (
              <Button
                key={value}
                label={value === "source" ? "Source" : "Steps"}
                accessibilityLabel={`${value === "source" ? "Source" : "Steps"} tab${tab === value ? ", selected" : ""}`}
                tone={tab === value ? "primary" : "secondary"}
                onPress={() => setTab(value)}
              />
            ))}
          </View>
        </View>
        <ScrollView ref={bodyScroll} className="flex-1" contentContainerClassName="gap-4 p-4">
          {bundle ? (
            <View className="gap-2">
              <Text selectable className="text-xs text-foreground-muted">
                Package: {bundle.packageId} · {bundle.version}
              </Text>
              <Text selectable className="font-mono text-xs text-foreground-muted">
                Declared SHA-256: {bundle.hash}
              </Text>
              <Text
                className={
                  verification?.valid === false
                    ? "text-xs text-warning-foreground"
                    : "text-xs text-foreground-muted"
                }
              >
                {verification === null
                  ? "Checking package integrity…"
                  : verification.valid
                    ? "Package integrity verified"
                    : verification.error}
              </Text>
              <Text className="text-sm">Target: {bundle.target.label}</Text>
              {bundle.target.identity ? (
                <Text selectable className="text-xs text-foreground-muted">
                  Target identity: {bundle.target.identity}
                </Text>
              ) : null}
              <Text className="text-xs text-foreground-muted">
                Requested rights: {bundle.target.rights?.join(", ") || "Not supplied"}
              </Text>
              {props.authority ? (
                <View className="gap-1">
                  <Text selectable className="text-xs text-foreground-muted">
                    Verified target: {props.authority.verifiedTargetId}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    Host approval: {props.authority.state} · Expires{" "}
                    {new Date(props.authority.expiresAt).toISOString()}
                  </Text>
                </View>
              ) : null}
              {bundle.warnings.map((warning, index) => (
                <Text key={index} className="text-sm text-warning-foreground">
                  {warning}
                </Text>
              ))}
            </View>
          ) : null}
          {tab === "source" ? (
            bundle ? (
              <View className="gap-3">
                <View className="flex-row flex-wrap gap-2">
                  {bundle.files.map((entry) => (
                    <Button
                      key={entry.path}
                      label={entry.path}
                      accessibilityLabel={`Open source ${entry.path}`}
                      tone={file?.path === entry.path ? "primary" : "secondary"}
                      onPress={() => openSource(entry.path, 1)}
                    />
                  ))}
                </View>
                {file ? (
                  <>
                    <Text selectable className="font-mono text-xs text-foreground-muted">
                      {file.path} · Declared SHA-256: {file.sha256}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      Lines {pageStart + 1}–{pageEnd} of {lines.length} · Selected line{" "}
                      {source.line}
                    </Text>
                    <ScrollView horizontal className="rounded-xl bg-card-alt">
                      <View className="flex-row gap-3 p-3">
                        <Text className="font-mono text-sm leading-6 text-foreground-muted">
                          {lines
                            .slice(pageStart, pageEnd)
                            .map((_, index) => pageStart + index + 1)
                            .join("\n")}
                        </Text>
                        <Text selectable className="font-mono text-sm leading-6">
                          {lines.slice(pageStart, pageEnd).join("\n")}
                        </Text>
                      </View>
                    </ScrollView>
                    <View className="flex-row flex-wrap gap-2">
                      <Button
                        label="Previous lines"
                        disabled={pageStart === 0}
                        onPress={() =>
                          openSource(file.path, Math.max(1, pageStart - SOURCE_PAGE_LINES + 1))
                        }
                      />
                      <Button
                        label="Next lines"
                        disabled={pageEnd >= lines.length}
                        onPress={() => openSource(file.path, pageEnd + 1)}
                      />
                    </View>
                  </>
                ) : (
                  <Text className="text-sm text-foreground-muted">No source files supplied.</Text>
                )}
                {bundle.symbols.length > 0 ? (
                  <View className="gap-2">
                    <Text accessibilityRole="header" className="font-t3-medium">
                      Symbols
                    </Text>
                    {bundle.symbols.map((symbol, index) => (
                      <Button
                        key={index}
                        label={`${symbol.name} · ${symbol.path}:${symbol.line}`}
                        onPress={() => openSource(symbol.path, symbol.line)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : (
              <Text selectable className="font-mono text-sm leading-6">
                {props.detail ?? "No details supplied"}
              </Text>
            )
          ) : bundle && bundle.steps.length > 0 ? (
            <View className="gap-3">
              {bundle.steps.map((step) => (
                <View
                  key={step.id}
                  className="gap-2 rounded-xl border border-border bg-card-alt p-3"
                >
                  <Text className="font-t3-bold">{step.title}</Text>
                  <Text selectable className="text-sm">
                    {step.description}
                  </Text>
                  <Text selectable className="text-xs text-foreground-muted">
                    {step.id}
                    {step.kind ? ` · ${step.kind}` : ""}
                  </Text>
                  {step.effects?.map((effect, index) => (
                    <Text key={index} className="text-sm text-warning-foreground">
                      {effect}
                    </Text>
                  ))}
                  {step.source ? (
                    <Button
                      label={`${step.source.path}:${step.source.line}${step.source.endLine ? `–${step.source.endLine}` : ""}`}
                      accessibilityLabel={`View source for ${step.title}`}
                      onPress={() => {
                        if (step.source) openSource(step.source.path, step.source.line);
                      }}
                    />
                  ) : null}
                </View>
              ))}
              {bundle.edges.length > 0 ? (
                <View className="gap-2">
                  <Text accessibilityRole="header" className="font-t3-medium">
                    Connections
                  </Text>
                  {bundle.edges.map((edge, index) => (
                    <Text key={index} selectable className="text-sm">
                      {edge.from} → {edge.to}
                      {edge.label ? ` · ${edge.label}` : ""}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : (
            <Text className="text-sm text-foreground-muted">No step graph supplied.</Text>
          )}
          {bundle ? (
            <>
              <Button
                label={showOriginal ? "Hide original request" : "Show original request"}
                onPress={() => setShowOriginal((value) => !value)}
              />
              {showOriginal ? (
                <Text selectable className="font-mono text-sm leading-6">
                  {props.detail}
                </Text>
              ) : null}
            </>
          ) : null}
          <Text selectable className="text-xs text-foreground-muted">
            Request: {props.requestId}
          </Text>
          {props.renderResponseControls(verification?.valid === true)}
        </ScrollView>
      </View>
    </Modal>
  );
}
