const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// Morrowbyte release signing";

function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;
  const signingConfigs = /signingConfigs\s*\{/;
  const releaseSigning =
    /(\bbuildTypes\s*\{[\s\S]*?\brelease\s*\{[^}]*?)signingConfig signingConfigs\.debug\b/;
  if (!signingConfigs.test(contents) || !releaseSigning.test(contents)) {
    throw new Error("Android release signing template changed; refusing a debug-signed release.");
  }
  const environment = `${MARKER}
def morrowbyteSigning = [
    storeFile: System.getenv("MORROWBYTE_ANDROID_KEYSTORE_PATH"),
    storePassword: System.getenv("MORROWBYTE_ANDROID_STORE_PASSWORD"),
    keyAlias: System.getenv("MORROWBYTE_ANDROID_KEY_ALIAS"),
    keyPassword: System.getenv("MORROWBYTE_ANDROID_KEY_PASSWORD")
]
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.toLowerCase().contains("release") } &&
        morrowbyteSigning.values().any { it == null || it.isEmpty() }) {
        throw new GradleException("Morrowbyte release signing environment is incomplete.")
    }
}
`;
  return (
    environment +
    contents
      .replace(
        signingConfigs,
        `signingConfigs {
        morrowbyteRelease {
            if (morrowbyteSigning.storeFile) storeFile file(morrowbyteSigning.storeFile)
            storeType "PKCS12"
            storePassword morrowbyteSigning.storePassword
            keyAlias morrowbyteSigning.keyAlias
            keyPassword morrowbyteSigning.keyPassword
        }`,
      )
      .replace(releaseSigning, "$1signingConfig signingConfigs.morrowbyteRelease")
  );
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("Morrowbyte release signing requires the reviewed Groovy template.");
    }
    nextConfig.modResults.contents = applyReleaseSigning(nextConfig.modResults.contents);
    return nextConfig;
  });
};
module.exports.applyReleaseSigning = applyReleaseSigning;
