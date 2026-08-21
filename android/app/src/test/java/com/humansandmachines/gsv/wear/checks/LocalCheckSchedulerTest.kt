package com.humansandmachines.gsv.wear.checks

import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.target.AndroidTargetCommands
import com.humansandmachines.gsv.wear.target.AndroidTargetFileSystem
import com.humansandmachines.gsv.wear.target.TargetCommand
import com.humansandmachines.gsv.wear.target.TargetCommandResult
import com.humansandmachines.gsv.wear.target.TargetShell
import com.humansandmachines.gsv.wear.target.TargetTestRuntime
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LocalCheckSchedulerTest {
    private lateinit var root: File
    private lateinit var fileSystem: AndroidTargetFileSystem
    private lateinit var authority: WearAuthority
    private lateinit var scheduler: LocalCheckScheduler

    @Before
    fun setUp() {
        root = Files.createTempDirectory("gsv-local-checks-").toFile()
        fileSystem = AndroidTargetFileSystem(
            persistentRoot = File(root, "home"),
            temporaryRoot = File(root, "tmp"),
            runtime = TargetTestRuntime(),
        )
        authority = WearAuthority { "check-lease" }.also { it.arm() }
        scheduler = newScheduler()
    }

    @After
    fun tearDown() {
        scheduler.close()
        root.deleteRecursively()
    }

    @Test
    fun persistsAndRunsAnOfflineCheckIntoItsJournal() = runBlocking {
        val device = TargetCommand(
            name = "device",
            description = "test device",
            usage = "device battery",
            category = "android",
        ) { _, _ -> TargetCommandResult(stdout = "{\"level\":42}\n") }
        val shell = TargetShell(
            fileSystem,
            AndroidTargetCommands.create(fileSystem, listOf(device) + scheduler.commands()),
        )
        scheduler.attach(
            TargetShell(
                fileSystem,
                AndroidTargetCommands.create(fileSystem, listOf(device) + scheduler.commands()),
            ),
        )
        scheduler.start()

        val added = shell.execute(
            JSONObject().put(
                "input",
                "checks add battery --every 10s --command \"device battery\"",
            ),
        )
        val id = JSONObject(added.getString("output")).getJSONObject("check").getString("id")
        val queued = shell.execute(JSONObject().put("input", "checks run $id"))

        assertTrue(JSONObject(queued.getString("output")).getBoolean("queued"))
        val journal = "/home/android/checks/$id/events.jsonl"
        withTimeout(1_000) {
            while (!exists(journal)) delay(10)
        }
        assertTrue(exists(journal))
        val text = fileSystem.open(journal).use { opened -> opened.open().use { it.readBytes().toString(Charsets.UTF_8) } }
        assertTrue(text.contains("\\\"level\\\":42"))

        scheduler.close()
        scheduler = newScheduler()
        val restoredShell = TargetShell(
            fileSystem,
            AndroidTargetCommands.create(fileSystem, scheduler.commands()),
        )
        scheduler.attach(
            TargetShell(fileSystem, AndroidTargetCommands.create(fileSystem, scheduler.commands())),
        )
        val restored = restoredShell.execute(JSONObject().put("input", "checks list"))
        assertEquals(1, JSONObject(restored.getString("output")).getInt("count"))
    }

    @Test
    fun removingACheckCancelsItsManualRunWithoutBlockingTheManagementShell() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val device = TargetCommand(
            name = "device",
            description = "blocking test device",
            usage = "device status",
            category = "android",
        ) { _, _ ->
            started.complete(Unit)
            try {
                delay(Long.MAX_VALUE)
                TargetCommandResult(stdout = "{}\n")
            } catch (error: CancellationException) {
                cancelled.complete(Unit)
                throw error
            }
        }
        val commands = AndroidTargetCommands.create(fileSystem, listOf(device) + scheduler.commands())
        val managementShell = TargetShell(fileSystem, commands)
        scheduler.attach(TargetShell(fileSystem, commands))
        scheduler.start()
        val added = managementShell.execute(
            JSONObject().put(
                "input",
                "checks add blocking --every 10s --command \"device status\"",
            ),
        )
        val id = JSONObject(added.getString("output")).getJSONObject("check").getString("id")

        managementShell.execute(JSONObject().put("input", "checks run $id"))
        withTimeout(1_000) { started.await() }
        val removed = managementShell.execute(JSONObject().put("input", "checks remove $id"))

        assertTrue(JSONObject(removed.getString("output")).getBoolean("removed"))
        withTimeout(1_000) { cancelled.await() }
    }

    private fun newScheduler(): LocalCheckScheduler = LocalCheckScheduler(
        parentScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        fileSystem = fileSystem,
        authority = authority,
        stateFile = File(root, "checks.json"),
    )

    private suspend fun exists(path: String): Boolean = try {
        fileSystem.stat(path)
        true
    } catch (_: Exception) {
        false
    }
}
