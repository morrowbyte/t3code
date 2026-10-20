package expo.modules.t3nativecontrols

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipFile

internal class ApkUpdateVerifier(private val context: Context) {
  companion object {
    private const val PACKAGE = "com.morrowbyte.t3code"
    private const val CERT = "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2"
    private const val MAX_BYTES = 250L * 1024 * 1024

    internal fun pruneInstallerFiles(directory: File, current: File, now: Long) {
      val copies = directory.listFiles()?.filter {
        Regex("install-[a-f0-9]{64}\\.apk").matches(it.name) &&
          it.isFile && it.canonicalFile == it.absoluteFile && it != current
      } ?: return
      // There is no installer-result callback. Keep the previous handoff and a full day of read grace.
      val previous = copies.maxByOrNull { it.lastModified() }
      copies.asSequence()
        .filter { it != previous && it.lastModified() <= now - 24L * 60 * 60 * 1000 }
        .sortedBy { it.lastModified() }
        .take(8)
        .forEach { it.delete() }
    }
  }

  private val directory: File get() = File(context.cacheDir, "apk-updates").canonicalFile

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun certificates(info: PackageInfo): List<String> {
    check(Build.VERSION.SDK_INT >= 28) { "APK updates require Android 9 or newer." }
    val signing = info.signingInfo ?: error("The Android signing identity is unavailable.")
    return signing.apkContentsSigners.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
        .joinToString("") { "%02x".format(it) }
    }.sorted()
  }

  private fun code(info: PackageInfo): Long {
    check(Build.VERSION.SDK_INT >= 28) { "APK updates require Android 9 or newer." }
    return info.longVersionCode
  }

  @Suppress("DEPRECATION")
  private fun installed(): PackageInfo = context.packageManager.getPackageInfo(
    context.packageName, PackageManager.GET_SIGNING_CERTIFICATES
  )

  fun identity(): Map<String, Any> {
    val info = installed()
    return mapOf(
      "packageName" to info.packageName,
      "versionName" to (info.versionName ?: ""),
      "versionCode" to code(info),
      "certificateSha256" to certificates(info),
      "supportedAbis" to Build.SUPPORTED_ABIS.toList()
    )
  }

  fun requireProduction() {
    val info = installed()
    check(context.packageName == PACKAGE && info.packageName == PACKAGE && certificates(info) == listOf(CERT)) {
      "APK updates require the Morrowbyte production app and its release signature."
    }
    check(Build.SUPPORTED_ABIS.contains("arm64-v8a")) { "This device cannot run the published ARM64 APK." }
  }

  @Suppress("DEPRECATION")
  fun verify(uri: String, digest: String, version: String, versionCode: Double, bytes: Double): File {
    requireProduction()
    require(Regex("[a-f0-9]{64}").matches(digest)) { "Invalid APK digest." }
    require(versionCode >= 1 && versionCode <= Int.MAX_VALUE && versionCode % 1.0 == 0.0) { "Invalid APK version code." }
    require(bytes >= 1 && bytes <= MAX_BYTES && bytes % 1.0 == 0.0) { "Invalid APK size." }
    val parsed = URI(uri)
    require(parsed.scheme == "file" && parsed.authority == null && parsed.query == null && parsed.fragment == null) {
      "The APK must be an app-private download."
    }
    val file = File(parsed).canonicalFile
    require(file.parentFile == directory && file.isFile && file.name.endsWith(".apk")) {
      "The APK must be in the private update directory."
    }
    require(file.length() == bytes.toLong() && sha256(file) == digest) { "The downloaded APK digest or size does not match." }
    val archive = context.packageManager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
      ?: error("Android could not verify the APK archive.")
    require(archive.packageName == PACKAGE && archive.versionName == version && code(archive) == versionCode.toLong()) {
      "The APK package or version does not match the release."
    }
    require(code(archive) > code(installed())) { "The APK is already installed or older." }
    require(archive.splitNames.isNullOrEmpty()) { "Only a standalone APK can be installed." }
    require((archive.applicationInfo?.flags ?: ApplicationInfo.FLAG_DEBUGGABLE) and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
      "A development APK cannot be installed as a production update."
    }
    require(certificates(archive) == listOf(CERT)) { "The APK release signature does not match the installed app." }
    ZipFile(file).use { zip ->
      var libraries = 0
      for (entry in zip.entries()) {
        if (entry.isDirectory || !entry.name.startsWith("lib/") || !entry.name.endsWith(".so")) continue
        val segments = entry.name.split('/')
        require(segments.size == 3 && segments[1] == "arm64-v8a") { "The APK contains an unexpected native ABI." }
        val header = ByteArray(20)
        zip.getInputStream(entry).use { input ->
          var offset = 0
          while (offset < header.size) {
            val count = input.read(header, offset, header.size - offset)
            require(count > 0) { "The APK contains a truncated native library." }
            offset += count
          }
        }
        require(header[0] == 0x7f.toByte() && header[1] == 0x45.toByte() && header[2] == 0x4c.toByte() &&
          header[3] == 0x46.toByte() && header[4] == 2.toByte() && header[5] == 1.toByte() &&
          (header[18].toInt() and 0xff) == 183 && header[19] == 0.toByte()) { "The native library is not ARM64 ELF." }
        libraries += 1
      }
      require(libraries > 0) { "The APK has no ARM64 native runtime." }
    }
    return file
  }

  fun installerFile(uri: String, digest: String, version: String, versionCode: Double, bytes: Double): File {
    val downloaded = verify(uri, digest, version, versionCode, bytes)
    val target = File(directory, "install-$digest.apk")
    if (!target.isFile) {
      val temporary = File(directory, "${UUID.randomUUID()}.apk")
      try {
        downloaded.copyTo(temporary)
        verify(temporary.toURI().toString(), digest, version, versionCode, bytes)
        check(temporary.setReadOnly()) { "Could not protect the installer file." }
        check(temporary.renameTo(target)) { "Could not prepare the installer file." }
      } finally {
        temporary.delete()
      }
    }
    // A private copy survives the settings screen closing while Android reads it.
    val verified = verify(target.toURI().toString(), digest, version, versionCode, bytes)
    val now = System.currentTimeMillis()
    check(verified.setLastModified(now)) { "Could not retain the installer handoff." }
    pruneInstallerFiles(directory, verified, now)
    return verified
  }
}
