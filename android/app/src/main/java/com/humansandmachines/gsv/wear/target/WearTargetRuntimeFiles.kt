package com.humansandmachines.gsv.wear.target

import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.CameraCaptureFailure
import com.humansandmachines.gsv.wear.camera.SnapshotCamera
import com.humansandmachines.gsv.wear.protocol.GsvProtocol
import com.humansandmachines.gsv.wear.runtime.WearRuntimeState
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject

class WearTargetRuntimeFiles(
    private val authority: WearAuthority,
    private val camera: SnapshotCamera,
    private val deviceInfo: () -> JSONObject,
) : TargetRuntimeFiles {
    override val directories: Set<String> = setOf(
        "/dev",
        "/dev/camera",
        "/dev/camera/back",
        "/dev/wear",
        "/proc",
        "/proc/wear",
    )

    override val files: Set<String> = setOf(
        README,
        PROC_CAPABILITIES,
        PROC_DEVICE,
        PROC_RUNTIME,
        PROC_WEAR_STATUS,
        STATUS,
        CAMERA_SNAPSHOT,
    )

    override suspend fun stat(path: String): TargetStat? {
        if (path !in files) return null
        if (path == CAMERA_SNAPSHOT) {
            return TargetStat(
                path = path,
                isFile = true,
                isDirectory = false,
                size = 0,
                contentType = "image/jpeg",
                eventProducing = true,
            )
        }
        val bytes = textContent(path)?.toByteArray(Charsets.UTF_8) ?: return null
        return TargetStat(
            path = path,
            isFile = true,
            isDirectory = false,
            size = bytes.size.toLong(),
            contentType = contentType(path),
        )
    }

    override suspend fun open(path: String): TargetReadHandle? {
        if (path !in files) return null
        if (path == CAMERA_SNAPSHOT) return openCamera(path)
        val bytes = textContent(path)?.toByteArray(Charsets.UTF_8) ?: return null
        return TargetReadHandle.fromBytes(path, bytes, contentType(path))
    }

    fun statusJson(): JSONObject {
        val snapshot = WearRuntimeState.snapshot.value
        return JSONObject()
            .put("wearAuthority", snapshot.authority.name.lowercase())
            .put("connection", snapshot.connection.name.lowercase())
            .put("camera", snapshot.camera.name.lowercase())
            .put("microphone", snapshot.microphone.name.lowercase())
            .put(
                "capabilities",
                JSONObject().put(
                    "camera.snapshot",
                    JSONObject()
                        .put("authorized", snapshot.authority == AuthorityState.ARMED)
                        .put("path", CAMERA_SNAPSHOT)
                        .put("timeoutMs", 5_000),
                )
                    .put("camera.observe", JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED))
                    .put("microphone.sample", JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED))
                    .put("microphone.observe", JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED))
                    .put(
                        "microphone.listen_until_speech",
                        JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED),
                    )
                    .put("gesture.session", JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED))
                    .put("imu.sample", JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED))
                    .put("location.current", JSONObject().put("authorized", snapshot.authority == AuthorityState.ARMED)),
            )
            .put("rawMediaRetained", false)
            .put("rawMediaRetention", "only_when_explicitly_materialized")
    }

    private suspend fun openCamera(path: String): TargetReadHandle {
        val lease = authority.acquire() ?: throw CameraCaptureFailure(
            if (authority.state() == AuthorityState.PAUSED) {
                "Wear Mode is paused"
            } else {
                "Wear Mode is not armed"
            },
        )
        val snapshot = camera.capture(lease)
        if (!authority.isCurrent(lease)) {
            snapshot.close()
            throw CameraCaptureFailure("Wear Mode authority changed during capture")
        }
        currentCoroutineContext().ensureActive()
        return TargetReadHandle.fromFile(
            path = path,
            file = snapshot.file,
            contentType = "image/jpeg",
            eventProducing = true,
            cleanup = snapshot::close,
        )
    }

    private fun textContent(path: String): String? = when (path) {
        README -> README_CONTENT
        PROC_DEVICE -> deviceInfo().toString(2) + "\n"
        PROC_CAPABILITIES -> capabilitiesJson().toString(2) + "\n"
        PROC_RUNTIME -> runtimeJson().toString(2) + "\n"
        PROC_WEAR_STATUS, STATUS -> statusJson().toString(2) + "\n"
        else -> null
    }

    private fun capabilitiesJson(): JSONObject = JSONObject()
        .put("syscalls", JSONArray(GsvProtocol.DRIVER_IMPLEMENTS))
        .put(
            "filesystem",
            JSONObject()
                .put("home", TargetPath.HOME)
                .put("temporary", "/tmp")
                .put("maximumFileBytes", AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES)
                .put("maximumTextReadBytes", AndroidTargetFileSystem.MAX_TEXT_READ_BYTES)
                .put("persistentBytes", AndroidTargetFileSystem.MAX_PERSISTENT_BYTES)
                .put("temporaryBytes", AndroidTargetFileSystem.MAX_TEMPORARY_BYTES)
                .put("maximumEntriesPerMount", AndroidTargetFileSystem.MAX_ENTRIES_PER_MOUNT),
        )
        .put(
            "wear",
            JSONObject()
                .put(
                    "camera.snapshot",
                    JSONObject()
                        .put("path", CAMERA_SNAPSHOT)
                        .put("materializeCommand", "camera snapshot [DESTINATION]"),
                )
                .put("camera.observe", "camera observe DURATION [DESTINATION]")
                .put("microphone.sample", "microphone sample DURATION [DESTINATION]")
                .put("microphone.observe", "microphone observe DURATION [DESTINATION]")
                .put("microphone.listenUntilSpeech", "microphone listen-until-speech [DESTINATION]")
                .put("gesture.session", "gesture session DURATION [DESTINATION]")
                .put("imu.sample", "imu sample DURATION [DESTINATION]"),
        )
        .put(
            "android",
            JSONObject()
                .put("device", "device status|battery|network|thermal")
                .put(
                    "location",
                    "location current [--provider best|gps|network] [--max-age DURATION] " +
                        "[--force] [--allow-cached] [--timeout DURATION]",
                )
                .put("notifications", "notifications status|list|read|dismiss|action|reply")
                .put("apps", "apps list|open")
                .put("intent", "intent open")
                .put("share", "share text|file")
                .put("clipboard", "clipboard read|write|clear")
                .put("output", "notify|speak|vibrate")
                .put("checks", "checks status|list|show|add|remove|enable|disable|run"),
        )

    private fun runtimeJson(): JSONObject {
        val snapshot = WearRuntimeState.snapshot.value
        return JSONObject()
            .put("connection", snapshot.connection.name.lowercase())
            .put("authority", snapshot.authority.name.lowercase())
            .put("camera", snapshot.camera.name.lowercase())
            .put("microphone", snapshot.microphone.name.lowercase())
    }

    private fun contentType(path: String): String = when (path) {
        README -> "text/plain; charset=utf-8"
        else -> "application/json; charset=utf-8"
    }

    companion object {
        const val README = "/README.txt"
        const val PROC_CAPABILITIES = "/proc/capabilities.json"
        const val PROC_DEVICE = "/proc/device.json"
        const val PROC_RUNTIME = "/proc/runtime.json"
        const val PROC_WEAR_STATUS = "/proc/wear/status.json"
        const val STATUS = "/dev/wear/status"
        const val CAMERA_SNAPSHOT = "/dev/camera/back/snapshot"

        private val README_CONTENT = """
            GSV Android target

            This phone exposes a bounded virtual filesystem and shell through GSV.

            Filesystem:
              /README.txt
              /proc/device.json
              /proc/capabilities.json
              /proc/runtime.json
              /proc/wear/status.json
              /dev/wear/status
              /dev/camera/back/snapshot
              /home/android
              /tmp

            Writable paths:
              /home/android  persistent app-private files
              /tmp           temporary app-private files

            Shell:
              Run `help` or `commands --json` for discovery.
              Android shell commands operate only on this virtual filesystem.

            Android capabilities:
              camera snapshot|observe|status
              microphone sample|observe|listen-until-speech|status
              sensors status; imu sample; gesture session; orientation current
              device status|battery|network|thermal; location current
              notifications; apps; intent; share; clipboard
              notify; speak; vibrate; checks

            Wear Mode:
              Reading /dev/camera/back/snapshot or running `camera snapshot`
              requires Wear Mode to have been armed locally.
        """.trimIndent() + "\n"
    }
}
