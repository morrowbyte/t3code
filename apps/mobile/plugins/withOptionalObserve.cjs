const { withSettingsGradle } = require("expo/config-plugins");

const BEGIN = "// @generated begin optional-expo-observe";
const END = "// @generated end optional-expo-observe";

function applyOptionalObserve(contents, projectId) {
  const withoutOverride = contents.replace(new RegExp(`${BEGIN}\\n[\\s\\S]*?${END}\\n`, "g"), "");
  if (typeof projectId === "string" && projectId.trim() !== "") return withoutOverride;

  const anchor = "expoAutolinking.useExpoModules()";
  if (!withoutOverride.includes(anchor)) {
    throw new Error("Optional Observe requires the Expo settings.gradle autolinking template.");
  }
  // Android calls Observe's OnCreate for every linked module, before the JS availability guard.
  return withoutOverride.replace(
    anchor,
    `${BEGIN}\nexpoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ["expo-observe"]\n${END}\n${anchor}`,
  );
}

module.exports = function withOptionalObserve(config) {
  return withSettingsGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("Optional Observe requires Groovy settings.gradle.");
    }
    nextConfig.modResults.contents = applyOptionalObserve(
      nextConfig.modResults.contents,
      nextConfig.extra?.eas?.projectId,
    );
    return nextConfig;
  });
};
module.exports.applyOptionalObserve = applyOptionalObserve;
