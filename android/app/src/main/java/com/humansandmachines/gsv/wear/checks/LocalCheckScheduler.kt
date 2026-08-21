package com.humansandmachines.gsv.wear.checks

import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.target.TargetCommand
import com.humansandmachines.gsv.wear.target.TargetCommandContext
import com.humansandmachines.gsv.wear.target.TargetCommandResult
import com.humansandmachines.gsv.wear.target.TargetFileSystem
import com.humansandmachines.gsv.wear.target.TargetFsException
import com.humansandmachines.gsv.wear.target.TargetPath
import com.humansandmachines.gsv.wear.target.TargetShell
import com.humansandmachines.gsv.wear.target.parseDurationMillis
import com.humansandmachines.gsv.wear.target.shellJson
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class LocalCheckScheduler(
    parentScope: CoroutineScope,
    private val fileSystem: TargetFileSystem,
    private val authority: WearAuthority,
    stateFile: File,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : Closeable {
    private val scope = CoroutineScope(
        parentScope.coroutineContext + SupervisorJob(parentScope.coroutineContext[Job]),
    )
    private val state = stateFile
    private val mutex = Mutex()
    private val records = linkedMapOf<String, CheckRecord>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val manualRuns = ConcurrentHashMap<String, Job>()
    private val running = ConcurrentHashMap.newKeySet<String>()
    private val active = AtomicBoolean(false)
    private var shell: TargetShell? = null

    init {
        load()
    }

    fun attach(shell: TargetShell) {
        check(this.shell == null) { "Local check shell is already attached" }
        this.shell = shell
    }

    fun commands(): List<TargetCommand> = listOf(
        TargetCommand(
            name = "checks",
            description = "Manage persisted sensor and context checks that continue while the armed service is offline",
            usage = "checks status | list | show ID | add NAME --every DURATION --command COMMAND | remove ID | enable ID | disable ID | run ID",
            category = "automation",
            run = ::command,
        ),
    )

    fun start() {
        if (!active.compareAndSet(false, true)) return
        scope.launch { mutex.withLock { records.values.forEach(::scheduleLocked) } }
    }

    fun stop() {
        active.set(false)
        jobs.values.forEach { job -> job.cancel(CancellationException("Local checks stopped")) }
        manualRuns.values.forEach { job -> job.cancel(CancellationException("Local checks stopped")) }
        jobs.clear()
        manualRuns.clear()
        running.clear()
    }

    override fun close() {
        stop()
        scope.cancel(CancellationException("Local check scheduler closed"))
    }

    private suspend fun command(
        args: List<String>,
        context: TargetCommandContext,
    ): TargetCommandResult = when {
        args == listOf("status") -> shellJson(status())
        args == listOf("list") -> shellJson(list())
        args.size == 2 && args[0] == "show" -> shellJson(show(args[1]))
        args.firstOrNull() == "add" -> shellJson(add(args.drop(1)))
        args.size == 2 && args[0] == "remove" -> shellJson(remove(args[1]))
        args.size == 2 && args[0] == "enable" -> shellJson(setEnabled(args[1], true))
        args.size == 2 && args[0] == "disable" -> shellJson(setEnabled(args[1], false))
        args.size == 2 && args[0] == "run" -> shellJson(runNow(args[1]))
        else -> usage(
            "checks status | list | show ID | add NAME --every DURATION --command COMMAND | remove ID | enable ID | disable ID | run ID",
        )
    }

    private suspend fun status(): JSONObject = mutex.withLock {
        JSONObject()
            .put("active", active.get())
            .put("armed", authority.state() == AuthorityState.ARMED)
            .put("count", records.size)
            .put("running", JSONArray(running.sorted()))
            .put("journalRoot", CHECK_ROOT)
    }

    private suspend fun list(): JSONObject = mutex.withLock {
        JSONObject()
            .put("checks", JSONArray(records.values.map(CheckRecord::toJson)))
            .put("count", records.size)
    }

    private suspend fun show(id: String): JSONObject = mutex.withLock {
        requireRecord(id).toJson()
    }

    private suspend fun add(args: List<String>): JSONObject {
        if (args.isEmpty()) return usageJson("checks add NAME --every DURATION --command COMMAND")
        val name = args[0]
        if (name.isBlank() || name.length > MAX_NAME_CHARS) throw TargetFsException("Check name is invalid")
        var every: Long? = null
        var command: String? = null
        var index = 1
        while (index < args.size) {
            val value = args.getOrNull(index + 1)
                ?: return usageJson("checks add NAME --every DURATION --command COMMAND")
            when (args[index]) {
                "--every" -> every = parseDurationMillis(value, "check interval")
                "--command" -> command = value
                else -> return usageJson("checks add NAME --every DURATION --command COMMAND")
            }
            index += 2
        }
        val interval = every ?: return usageJson("checks add NAME --every DURATION --command COMMAND")
        val shellCommand = command?.trim().orEmpty()
        if (interval !in MIN_INTERVAL_MILLIS..MAX_INTERVAL_MILLIS) {
            throw TargetFsException("Check interval must be between 10s and 24h")
        }
        validateScheduledCommand(shellCommand)
        return mutex.withLock {
            if (records.size >= MAX_CHECKS) throw TargetFsException("At most $MAX_CHECKS local checks are supported")
            if (records.values.any { it.name == name }) throw TargetFsException("A check named '$name' already exists")
            val now = nowMillis()
            val record = CheckRecord(
                id = UUID.randomUUID().toString().replace("-", "").take(16),
                name = name,
                everyMillis = interval,
                command = shellCommand,
                enabled = true,
                createdAt = now,
                nextRunAt = now + interval,
            )
            records[record.id] = record
            persistLocked()
            scheduleLocked(record)
            JSONObject().put("created", true).put("check", record.toJson())
        }
    }

    private suspend fun remove(id: String): JSONObject = mutex.withLock {
        val record = records.remove(id) ?: return@withLock JSONObject().put("removed", false).put("id", id)
        jobs.remove(id)?.cancel(CancellationException("Local check removed"))
        manualRuns.remove(id)?.cancel(CancellationException("Local check removed"))
        running.remove(id)
        persistLocked()
        JSONObject().put("removed", true).put("id", record.id)
    }

    private suspend fun setEnabled(id: String, enabled: Boolean): JSONObject = mutex.withLock {
        val record = requireRecord(id)
        record.enabled = enabled
        record.nextRunAt = if (enabled) nowMillis() + record.everyMillis else null
        jobs.remove(id)?.cancel(CancellationException("Local check state changed"))
        persistLocked()
        scheduleLocked(record)
        JSONObject().put("check", record.toJson())
    }

    private suspend fun runNow(id: String): JSONObject = mutex.withLock {
        val record = requireRecord(id)
        if (!active.get() || authority.state() != AuthorityState.ARMED) {
            throw TargetFsException("Local checks run only while Wear Mode is armed")
        }
        if (!running.add(id)) return@withLock JSONObject().put("queued", false).put("running", true).put("id", id)
        lateinit var job: Job
        job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                execute(record)
            } finally {
                running.remove(id)
                manualRuns.remove(id, job)
            }
        }
        manualRuns[id] = job
        job.start()
        JSONObject().put("queued", true).put("id", id)
    }

    private fun scheduleLocked(record: CheckRecord) {
        jobs.remove(record.id)?.cancel()
        if (!active.get() || !record.enabled || authority.state() != AuthorityState.ARMED) return
        jobs[record.id] = scope.launch {
            while (isActive && active.get() && record.enabled) {
                val next = mutex.withLock {
                    record.nextRunAt ?: (nowMillis() + record.everyMillis).also { record.nextRunAt = it }
                }
                delay((next - nowMillis()).coerceAtLeast(0))
                currentCoroutineContext().ensureActive()
                if (authority.state() != AuthorityState.ARMED) {
                    delay(AUTHORITY_RECHECK_MILLIS)
                    continue
                }
                if (running.add(record.id)) {
                    try {
                        execute(record)
                    } finally {
                        running.remove(record.id)
                    }
                }
                mutex.withLock {
                    record.nextRunAt = nowMillis() + record.everyMillis
                    persistLocked()
                }
            }
        }
    }

    private suspend fun execute(record: CheckRecord) {
        val runner = shell ?: throw TargetFsException("Local check shell is unavailable")
        val directory = TargetPath.join(CHECK_ROOT, record.id)
        fileSystem.mkdir(directory)
        val started = nowMillis()
        val input = materializeCommand(record.command, directory, started)
        val result = try {
            runner.execute(
                JSONObject()
                    .put("input", input)
                    .put("cwd", directory)
                    .put("timeout", CHECK_TIMEOUT_MILLIS),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            JSONObject()
                .put("status", "failed")
                .put("output", "")
                .put("error", error.message ?: "Local check failed")
        }
        val completed = nowMillis()
        val event = JSONObject()
            .put("checkId", record.id)
            .put("name", record.name)
            .put("startedAt", started)
            .put("completedAt", completed)
            .put("durationMs", completed - started)
            .put("status", result.optString("status", "failed"))
            .put("exitCode", result.optInt("exitCode", if (result.optString("status") == "completed") 0 else 1))
            .put("output", result.optString("output").take(MAX_JOURNAL_OUTPUT_CHARS))
            .apply { result.opt("error")?.let { put("error", it.toString().take(MAX_JOURNAL_OUTPUT_CHARS)) } }
        appendJournal(record.id, event)
        mutex.withLock {
            record.lastRunAt = completed
            record.lastStatus = event.getString("status")
            record.lastError = event.optString("error").takeIf(String::isNotBlank)
            persistLocked()
        }
    }

    private suspend fun appendJournal(id: String, event: JSONObject) {
        val directory = TargetPath.join(CHECK_ROOT, id)
        fileSystem.mkdir(directory)
        val path = TargetPath.join(directory, "events.jsonl")
        val previous = TargetPath.join(directory, "events.previous.jsonl")
        val line = event.toString() + "\n"
        val current = try {
            fileSystem.open(path).use { opened ->
                withContext(Dispatchers.IO) {
                    opened.open().use { it.readBytes().toString(Charsets.UTF_8) }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            ""
        }
        if (current.toByteArray(Charsets.UTF_8).size + line.toByteArray(Charsets.UTF_8).size > MAX_JOURNAL_BYTES) {
            try {
                fileSystem.delete(previous)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // Rotation is still valid when there is no previous journal.
            }
            if (current.isNotEmpty()) fileSystem.move(path, previous)
            fileSystem.writeText(path, line)
        } else {
            fileSystem.writeText(path, current + line)
        }
    }

    private fun materializeCommand(command: String, directory: String, timestamp: Long): String = when {
        command == "camera snapshot" -> "$command ${TargetPath.join(directory, "camera-$timestamp.jpg")}"
        CAMERA_OBSERVE_WITHOUT_DEST.matches(command) ->
            "$command ${TargetPath.join(directory, "camera-$timestamp")}"
        MICROPHONE_CAPTURE_WITHOUT_DEST.matches(command) ->
            "$command ${TargetPath.join(directory, "audio-$timestamp.wav")}"
        command == "microphone listen-until-speech" ->
            "$command ${TargetPath.join(directory, "speech-$timestamp.wav")}"
        GESTURE_WITHOUT_DEST.matches(command) ->
            "$command ${TargetPath.join(directory, "gesture-$timestamp.json")}"
        IMU_WITHOUT_DEST.matches(command) ->
            "$command ${TargetPath.join(directory, "imu-$timestamp.json")}"
        else -> command
    }

    private fun validateScheduledCommand(command: String) {
        if (command.isBlank() || command.length > MAX_COMMAND_CHARS) throw TargetFsException("Check command is invalid")
        val family = command.substringBefore(' ')
        if (family !in ALLOWED_COMMANDS) {
            throw TargetFsException("Local checks support only: ${ALLOWED_COMMANDS.sorted().joinToString(", ")}")
        }
        if (command.any { it == ';' || it == '|' || it == '<' || it == '>' || it == '\n' || it == '\r' }) {
            throw TargetFsException("Local check commands must contain one bounded command")
        }
    }

    private fun requireRecord(id: String): CheckRecord = records[id]
        ?: throw TargetFsException("Unknown local check: $id")

    private fun load() {
        if (!state.isFile) return
        val json = runCatching { state.inputStream().use { input -> JSONObject(input.reader().readText()) } }.getOrNull()
            ?: return
        val entries = json.optJSONArray("checks") ?: return
        for (index in 0 until entries.length()) {
            runCatching { CheckRecord.fromJson(entries.getJSONObject(index)) }
                .getOrNull()
                ?.takeIf { it.id.isNotBlank() && it.command.isNotBlank() }
                ?.let { records[it.id] = it }
        }
    }

    private suspend fun persistLocked() = withContext(Dispatchers.IO) {
        val parent = state.parentFile ?: throw TargetFsException("Local check state has no parent directory")
        if (!parent.mkdirs() && !parent.isDirectory) throw TargetFsException("Unable to create local check state directory")
        val temporary = File(parent, "${state.name}.tmp")
        try {
            val bytes = JSONObject()
                .put("version", 1)
                .put("checks", JSONArray(records.values.map(CheckRecord::toJson)))
                .toString()
                .toByteArray(Charsets.UTF_8)
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    state.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: Exception) {
                Files.move(temporary.toPath(), state.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (error: Exception) {
            temporary.delete()
            throw TargetFsException("Unable to persist local checks")
        }
    }

    private fun usage(value: String): TargetCommandResult = TargetCommandResult(
        stderr = "Usage: $value\n",
        exitCode = 2,
    )

    private fun usageJson(value: String): JSONObject = JSONObject().put("ok", false).put("error", "Usage: $value")

    private data class CheckRecord(
        val id: String,
        val name: String,
        val everyMillis: Long,
        val command: String,
        var enabled: Boolean,
        val createdAt: Long,
        var nextRunAt: Long?,
        var lastRunAt: Long? = null,
        var lastStatus: String? = null,
        var lastError: String? = null,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id)
            .put("name", name)
            .put("everyMs", everyMillis)
            .put("command", command)
            .put("enabled", enabled)
            .put("createdAt", createdAt)
            .put("nextRunAt", nextRunAt)
            .put("lastRunAt", lastRunAt)
            .put("lastStatus", lastStatus)
            .put("lastError", lastError)
            .put("journal", TargetPath.join(TargetPath.join(CHECK_ROOT, id), "events.jsonl"))

        companion object {
            fun fromJson(json: JSONObject): CheckRecord = CheckRecord(
                id = json.getString("id"),
                name = json.getString("name"),
                everyMillis = json.getLong("everyMs"),
                command = json.getString("command"),
                enabled = json.optBoolean("enabled", true),
                createdAt = json.getLong("createdAt"),
                nextRunAt = json.optLong("nextRunAt").takeIf { json.has("nextRunAt") && !json.isNull("nextRunAt") },
                lastRunAt = json.optLong("lastRunAt").takeIf { json.has("lastRunAt") && !json.isNull("lastRunAt") },
                lastStatus = json.optString("lastStatus").takeIf(String::isNotBlank),
                lastError = json.optString("lastError").takeIf(String::isNotBlank),
            )
        }
    }

    companion object {
        const val CHECK_ROOT = "/home/android/checks"
        private const val MAX_CHECKS = 32
        private const val MAX_NAME_CHARS = 64
        private const val MAX_COMMAND_CHARS = 2_048
        private const val MIN_INTERVAL_MILLIS = 10_000L
        private const val MAX_INTERVAL_MILLIS = 24L * 60 * 60 * 1_000
        private const val CHECK_TIMEOUT_MILLIS = 150_000L
        private const val AUTHORITY_RECHECK_MILLIS = 250L
        private const val MAX_JOURNAL_BYTES = 2 * 1024 * 1024
        private const val MAX_JOURNAL_OUTPUT_CHARS = 32 * 1024
        private val ALLOWED_COMMANDS = setOf(
            "camera",
            "microphone",
            "gesture",
            "imu",
            "orientation",
            "device",
            "location",
            "sensors",
            "notifications",
        )
        private val CAMERA_OBSERVE_WITHOUT_DEST = Regex("camera observe \\S+")
        private val MICROPHONE_CAPTURE_WITHOUT_DEST = Regex("microphone (sample|observe) \\S+")
        private val GESTURE_WITHOUT_DEST = Regex("gesture session \\S+")
        private val IMU_WITHOUT_DEST = Regex("imu sample \\S+")
    }
}
