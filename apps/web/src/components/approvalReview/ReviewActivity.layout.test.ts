import { expect, it } from "vite-plus/test";
import { activityLayout } from "./ReviewActivity.layout";
import { gitlabExampleBundle } from "./gitlabExample";

it("retains success and stop guards when decision details are collapsed", () => {
  const result = activityLayout(gitlabExampleBundle, false);
  expect(result.edges).toContainEqual({
    from: "check_expected_installation",
    to: "download_target_image",
    label: "Erfolg",
  });
  expect(result.edges).toContainEqual({
    from: "check_expected_installation",
    to: "stopped",
    label: "Fehler",
  });
  expect(
    result.edges.some(
      (edge) => edge.from === "start" && edge.to === "stopped" && edge.label?.includes("Beispiel"),
    ),
  ).toBe(true);
});

it("keeps all exact control-flow nodes and edges when expanded", () => {
  const result = activityLayout(gitlabExampleBundle, true);
  expect(result.steps).toEqual(gitlabExampleBundle.steps);
  expect(result.edges).toHaveLength(gitlabExampleBundle.edges.length);
  expect(result.edges).toEqual(expect.arrayContaining([...gitlabExampleBundle.edges]));
});
