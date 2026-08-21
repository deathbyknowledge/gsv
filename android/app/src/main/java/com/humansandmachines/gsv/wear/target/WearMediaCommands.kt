package com.humansandmachines.gsv.wear.target

import com.humansandmachines.gsv.wear.audio.CapturedAudio
import com.humansandmachines.gsv.wear.audio.WearMicrophone
import com.humansandmachines.gsv.wear.authority.AuthorityLease
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.ObservingCamera
import com.humansandmachines.gsv.wear.sensors.WearSensors
import java.io.FileInputStream
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class WearMediaCommands(
    private val authority: WearAuthority,
    private val camera: ObservingCamera,
    private val microphone: WearMicrophone,
    private val sensors: WearSensors,
) {
    fun commands(): List<TargetCommand> = listOf(
        TargetCommand(
            name = "camera",
            description = "Capture snapshots or timed observations from the back camera",
            usage = "camera status | snapshot [DESTINATION] | observe DURATION [DESTINATION] [--interval DURATION] [--frames N]",
            category = "wear",
            run = ::camera,
        ),
        TargetCommand(
            name = "microphone",
            description = "Capture audio, analyze an interval, or wait for speech",
            usage = "microphone status | sample DURATION [DESTINATION] | observe DURATION [DESTINATION] [--events CSV] | listen-until-speech [DESTINATION] [--timeout DURATION] [--trailing DURATION]",
            category = "wear",
            run = ::microphone,
        ),
        TargetCommand(
            name = "sensors",
            description = "List motion and orientation sensors",
            usage = "sensors status",
            category = "sensors",
        ) { args, _ ->
            if (args != listOf("status")) usage("sensors status") else shellJson(sensors.status())
        },
        TargetCommand(
            name = "imu",
            description = "Sample accelerometer, gyroscope, and orientation summaries",
            usage = "imu sample DURATION [DESTINATION]",
            category = "sensors",
            run = ::imu,
        ),
        TargetCommand(
            name = "gesture",
            description = "Run a bounded gesture-recognition session",
            usage = "gesture session DURATION [DESTINATION]",
            category = "sensors",
            run = ::gesture,
        ),
        TargetCommand(
            name = "orientation",
            description = "Read the device orientation from its rotation-vector sensor",
            usage = "orientation current [DURATION]",
            category = "sensors",
            run = ::orientation,
        ),
    )

    private suspend fun camera(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        return when (args.firstOrNull()) {
            "status" -> {
                if (args.size != 1) return usage("camera status")
                val status = JSONObject(readShellText(context.fileSystem, WearTargetRuntimeFiles.PROC_WEAR_STATUS))
                shellJson(
                    JSONObject()
                        .put("camera", status.optString("camera"))
                        .put("authorized", authority.state() == AuthorityState.ARMED)
                        .put("snapshotPath", WearTargetRuntimeFiles.CAMERA_SNAPSHOT),
                )
            }
            "snapshot" -> captureSnapshot(args.drop(1), context)
            "observe" -> observeCamera(args.drop(1), context)
            else -> usage(
                "camera status | snapshot [DESTINATION] | observe DURATION [DESTINATION] [--interval DURATION] [--frames N]",
            )
        }
    }

    private suspend fun captureSnapshot(
        args: List<String>,
        context: TargetCommandContext,
    ): TargetCommandResult {
        if (args.size > 1) return usage("camera snapshot [DESTINATION]")
        val lease = acquireLease()
        val destination = context.fileSystem.resolve(
            args.firstOrNull() ?: "/tmp/camera/snapshot-${context.nowMillis()}.jpg",
            context.cwd,
        )
        val snapshot = camera.capture(lease)
        snapshot.use { capture ->
            ensureCurrent(lease)
            FileInputStream(capture.file).use { input ->
                context.fileSystem.write(destination, input, capture.length, "image/jpeg")
            }
        }
        return shellJson(
            JSONObject()
                .put("path", destination)
                .put("size", context.fileSystem.stat(destination).size)
                .put("contentType", "image/jpeg"),
        )
    }

    private suspend fun observeCamera(
        args: List<String>,
        context: TargetCommandContext,
    ): TargetCommandResult {
        if (args.isEmpty()) return usage("camera observe DURATION [DESTINATION] [--interval DURATION] [--frames N]")
        val duration = parseDurationMillis(args[0], "camera duration")
        var destination: String? = null
        var interval = minOf(2_000L, duration)
        var frames = 16
        var index = 1
        while (index < args.size) {
            when (args[index]) {
                "--interval" -> {
                    interval = args.getOrNull(index + 1)?.let { parseDurationMillis(it, "camera interval") }
                        ?: return usage("camera observe DURATION [DESTINATION] [--interval DURATION] [--frames N]")
                    index += 2
                }
                "--frames" -> {
                    frames = args.getOrNull(index + 1)?.toIntOrNull()
                        ?: return usage("camera observe DURATION [DESTINATION] [--interval DURATION] [--frames N]")
                    index += 2
                }
                else -> {
                    if (destination != null || args[index].startsWith("--")) {
                        return usage("camera observe DURATION [DESTINATION] [--interval DURATION] [--frames N]")
                    }
                    destination = args[index]
                    index += 1
                }
            }
        }
        val root = context.fileSystem.resolve(
            destination ?: "/tmp/camera/observation-${context.nowMillis()}",
            context.cwd,
        )
        if (frames !in 1..16) throw TargetFsException("Camera observations support 1 to 16 frames")
        if (pathExists(context.fileSystem, root)) throw TargetFsException("Camera destination already exists: $root")
        context.fileSystem.mkdir(root)
        val materialized = mutableListOf<String>()
        val lease = acquireLease()
        try {
            camera.observe(lease, duration, interval, frames).use { observation ->
                ensureCurrent(lease)
                val entries = JSONArray()
                observation.snapshots.forEachIndexed { frameIndex, snapshot ->
                    val path = TargetPath.join(root, "frame-${(frameIndex + 1).toString().padStart(3, '0')}.jpg")
                    FileInputStream(snapshot.file).use { input ->
                        context.fileSystem.write(path, input, snapshot.length, "image/jpeg")
                    }
                    materialized += path
                    entries.put(
                        JSONObject()
                            .put("path", path)
                            .put("size", snapshot.length)
                            .put(
                                "capturedAt",
                                Instant.ofEpochMilli(snapshot.capturedAtMillis).toString(),
                            ),
                    )
                }
                val manifestPath = TargetPath.join(root, "observation.json")
                val manifest = JSONObject()
                    .put("startedAt", observation.startedAtMillis)
                    .put("completedAt", observation.completedAtMillis)
                    .put("durationMs", observation.completedAtMillis - observation.startedAtMillis)
                    .put("frames", entries)
                context.fileSystem.writeText(manifestPath, manifest.toString(2) + "\n")
                materialized += manifestPath
                return shellJson(
                    JSONObject()
                        .put("path", root)
                        .put("manifest", manifestPath)
                        .put("frameCount", entries.length())
                        .put("frames", entries),
                )
            }
        } catch (error: Exception) {
            withContext(NonCancellable) {
                materialized.asReversed().forEach { path -> runCatching { context.fileSystem.delete(path) } }
                runCatching { context.fileSystem.deleteEmptyDirectory(root) }
            }
            throw error
        }
    }

    private suspend fun microphone(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        return when (args.firstOrNull()) {
            "status" -> {
                if (args.size != 1) return usage("microphone status")
                val status = JSONObject(readShellText(context.fileSystem, WearTargetRuntimeFiles.PROC_WEAR_STATUS))
                shellJson(
                    JSONObject()
                        .put("microphone", status.optString("microphone"))
                        .put("authorized", authority.state() == AuthorityState.ARMED),
                )
            }
            "sample", "observe" -> captureAudio(args.first(), args.drop(1), context)
            "listen-until-speech" -> listenUntilSpeech(args.drop(1), context)
            else -> usage(
                "microphone status | sample DURATION [DESTINATION] | observe DURATION [DESTINATION] [--events CSV] | listen-until-speech [DESTINATION] [--timeout DURATION] [--trailing DURATION]",
            )
        }
    }

    private suspend fun captureAudio(
        mode: String,
        args: List<String>,
        context: TargetCommandContext,
    ): TargetCommandResult {
        if (args.isEmpty()) return usage("microphone $mode DURATION [DESTINATION]${if (mode == "observe") " [--events CSV]" else ""}")
        val duration = parseDurationMillis(args[0], "microphone duration")
        var destinationArg: String? = null
        var requestedEvents = emptyList<String>()
        var index = 1
        while (index < args.size) {
            when (args[index]) {
                "--events" -> {
                    if (mode != "observe") return usage("microphone sample DURATION [DESTINATION]")
                    val value = args.getOrNull(index + 1)
                        ?: return usage("microphone observe DURATION [DESTINATION] [--events CSV]")
                    requestedEvents = value.split(',').map(String::trim).filter(String::isNotBlank).distinct()
                    if (requestedEvents.isEmpty() || requestedEvents.size > 16) {
                        throw TargetFsException("Microphone event list must contain 1 to 16 names")
                    }
                    index += 2
                }
                else -> {
                    if (destinationArg != null || args[index].startsWith("--")) {
                        return usage("microphone $mode DURATION [DESTINATION]${if (mode == "observe") " [--events CSV]" else ""}")
                    }
                    destinationArg = args[index]
                    index += 1
                }
            }
        }
        val destination = context.fileSystem.resolve(
            destinationArg ?: "/tmp/audio/$mode-${context.nowMillis()}.wav",
            context.cwd,
        )
        val lease = acquireLease()
        val capture = if (mode == "sample") {
            microphone.sample(lease, duration)
        } else {
            microphone.observe(lease, duration)
        }
        annotateRequestedEvents(capture.analysis, requestedEvents)
        return materializeAudio(capture, destination, lease, context)
    }

    private suspend fun listenUntilSpeech(
        args: List<String>,
        context: TargetCommandContext,
    ): TargetCommandResult {
        var destination: String? = null
        var timeout = 30_000L
        var trailing = 1_500L
        var index = 0
        while (index < args.size) {
            when (args[index]) {
                "--timeout" -> {
                    timeout = args.getOrNull(index + 1)?.let { parseDurationMillis(it, "speech timeout") }
                        ?: return usage("microphone listen-until-speech [DESTINATION] [--timeout DURATION] [--trailing DURATION]")
                    index += 2
                }
                "--trailing" -> {
                    trailing = args.getOrNull(index + 1)?.let { parseDurationMillis(it, "speech trailing duration") }
                        ?: return usage("microphone listen-until-speech [DESTINATION] [--timeout DURATION] [--trailing DURATION]")
                    index += 2
                }
                else -> {
                    if (destination != null || args[index].startsWith("--")) {
                        return usage("microphone listen-until-speech [DESTINATION] [--timeout DURATION] [--trailing DURATION]")
                    }
                    destination = args[index]
                    index += 1
                }
            }
        }
        val path = context.fileSystem.resolve(
            destination ?: "/tmp/audio/speech-${context.nowMillis()}.wav",
            context.cwd,
        )
        val lease = acquireLease()
        val capture = microphone.listenUntilSpeech(lease, timeout, trailing)
        return materializeAudio(capture, path, lease, context)
    }

    private suspend fun materializeAudio(
        captured: CapturedAudio,
        destination: String,
        lease: AuthorityLease,
        context: TargetCommandContext,
    ): TargetCommandResult {
        val analysisPath = destination.removeSuffix(".wav") + ".json"
        return captured.use { capture ->
            if (pathExists(context.fileSystem, destination) || pathExists(context.fileSystem, analysisPath)) {
                throw TargetFsException("Microphone destination already exists")
            }
            val materialized = mutableListOf<String>()
            try {
                ensureCurrent(lease)
                FileInputStream(capture.file).use { input ->
                    context.fileSystem.write(destination, input, capture.length, "audio/wav")
                }
                materialized += destination
                context.fileSystem.writeText(analysisPath, capture.analysis.toString(2) + "\n")
                materialized += analysisPath
                shellJson(
                    JSONObject()
                        .put("path", destination)
                        .put("analysisPath", analysisPath)
                        .put("size", capture.length)
                        .put("contentType", "audio/wav")
                        .put("analysis", capture.analysis),
                )
            } catch (error: Exception) {
                withContext(NonCancellable) {
                    materialized.asReversed().forEach { path -> runCatching { context.fileSystem.delete(path) } }
                }
                throw error
            }
        }
    }

    private suspend fun imu(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        if (args.size !in 2..3 || args.firstOrNull() != "sample") {
            return usage("imu sample DURATION [DESTINATION]")
        }
        val result = sensors.sampleImu(acquireLease(), parseDurationMillis(args[1], "IMU duration"))
        args.getOrNull(2)?.let { destination ->
            context.fileSystem.writeText(
                context.fileSystem.resolve(destination, context.cwd),
                result.toString(2) + "\n",
            )
        }
        return shellJson(result)
    }

    private suspend fun gesture(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        if (args.size !in 2..3 || args.firstOrNull() != "session") {
            return usage("gesture session DURATION [DESTINATION]")
        }
        val result = sensors.gestureSession(acquireLease(), parseDurationMillis(args[1], "gesture duration"))
        args.getOrNull(2)?.let { destination ->
            context.fileSystem.writeText(
                context.fileSystem.resolve(destination, context.cwd),
                result.toString(2) + "\n",
            )
        }
        return shellJson(result)
    }

    private suspend fun orientation(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        if (args.isEmpty() || args.first() != "current" || args.size > 2) {
            return usage("orientation current [DURATION]")
        }
        val duration = args.getOrNull(1)?.let { parseDurationMillis(it, "orientation duration") } ?: 500L
        return shellJson(sensors.orientation(acquireLease(), duration))
    }

    private fun acquireLease(): AuthorityLease = authority.acquire() ?: throw TargetFsException(
        if (authority.state() == AuthorityState.PAUSED) "Wear Mode is paused" else "Wear Mode is not armed",
    )

    private fun annotateRequestedEvents(analysis: JSONObject, requested: List<String>) {
        if (requested.isEmpty()) return
        val detected = JSONObject()
        val requiresInference = JSONArray()
        requested.forEach { event ->
            when (event) {
                "speech", "speech_or_voice" -> detected.put(event, analysis.optBoolean("speechDetected"))
                "loud_sound" -> detected.put(event, analysis.optBoolean("loudSoundDetected"))
                "tone", "sustained_tone" -> detected.put(event, analysis.optBoolean("sustainedToneDetected"))
                else -> requiresInference.put(event)
            }
        }
        analysis
            .put("requestedEvents", JSONArray(requested))
            .put("requestedEventDetections", detected)
            .put("requiresSemanticInference", requiresInference)
    }

    private fun ensureCurrent(lease: AuthorityLease) {
        if (!authority.isCurrent(lease)) throw TargetFsException("Wear Mode authority changed during operation")
    }

    private suspend fun pathExists(fileSystem: TargetFileSystem, path: String): Boolean = try {
        fileSystem.stat(path)
        true
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        false
    }

    private fun usage(value: String): TargetCommandResult = TargetCommandResult(
        stderr = "Usage: $value\n",
        exitCode = 2,
    )
}
