package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TargetShellTest {
    private lateinit var root: File
    private lateinit var fileSystem: AndroidTargetFileSystem
    private lateinit var shell: TargetShell

    @Before
    fun setUp() {
        root = Files.createTempDirectory("gsv-android-shell-").toFile()
        fileSystem = AndroidTargetFileSystem(
            persistentRoot = File(root, "home"),
            temporaryRoot = File(root, "tmp"),
            runtime = TargetTestRuntime(),
        )
        shell = TargetShell(fileSystem)
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun pipesQuotesAndRedirectionOperateOnTheVirtualFilesystem() = runBlocking {
        val result = shell.execute(
            JSONObject().put(
                "input",
                "echo \"alpha beta\" > note.txt; echo gamma >> note.txt; cat note.txt | grep -n beta",
            ),
        )

        assertEquals("completed", result.getString("status"))
        assertEquals(0, result.getInt("exitCode"))
        assertEquals("1:alpha beta\n", result.getString("output"))
        assertEquals("alpha beta\ngamma\n", readText("/home/android/note.txt"))
    }

    @Test
    fun wcFlagsComposeInPipelinesAndForFiles() = runBlocking {
        fileSystem.writeText("/home/android/note.txt", "one two\nthree\n")

        val pipeline = shell.execute(JSONObject().put("input", "cat note.txt | grep three | wc -l"))
        val file = shell.execute(JSONObject().put("input", "wc -lwc note.txt"))

        assertEquals("completed", pipeline.getString("status"))
        assertEquals("1\n", pipeline.getString("output"))
        assertEquals("completed", file.getString("status"))
        assertEquals("2 3 14 note.txt\n", file.getString("output"))
    }

    @Test
    fun commandsJsonIsTheMachineReadableDiscoverySurface() = runBlocking {
        val result = shell.execute(JSONObject().put("input", "commands --json"))

        assertEquals("completed", result.getString("status"))
        val catalog = JSONArray(result.getString("output"))
        val names = List(catalog.length()) { catalog.getJSONObject(it).getString("name") }
        assertTrue("camera" in names)
        assertTrue("device" in names)
        assertTrue("wear" in names)
        assertTrue("cp" in names)
        assertTrue("grep" in names)
        assertTrue(catalog.getJSONObject(0).has("usage"))
    }

    @Test
    fun androidSystemCommandsAreNotReachable() = runBlocking {
        val result = shell.execute(JSONObject().put("input", "sh -c 'id'"))

        assertEquals("failed", result.getString("status"))
        assertEquals(127, result.getInt("exitCode"))
        assertTrue(result.getString("output").contains("sh: command not found"))
        assertFalse(File(root, "home/id").exists())
    }

    @Test
    fun rejectsSessionsBackgroundWorkAndInvalidWorkingDirectories() = runBlocking {
        assertEquals(
            "failed",
            shell.execute(JSONObject().put("input", "pwd").put("sessionId", "persistent")).getString("status"),
        )
        assertEquals(
            "failed",
            shell.execute(JSONObject().put("input", "pwd").put("background", true)).getString("status"),
        )
        assertEquals(
            "failed",
            shell.execute(JSONObject().put("input", "pwd").put("cwd", "/missing")).getString("status"),
        )
    }

    @Test
    fun commandTimeoutReturnsAStableFailure() = runBlocking {
        val timedShell = TargetShell(
            fileSystem = fileSystem,
            commands = listOf(
                TargetCommand("wait", "Wait for a test", "wait") { _, _ ->
                    delay(500)
                    TargetCommandResult(stdout = "late\n")
                },
            ),
        )

        val result = timedShell.execute(JSONObject().put("input", "wait").put("timeout", 10))

        assertEquals("failed", result.getString("status"))
        assertTrue(result.getString("error").contains("timed out"))
        assertEquals("", result.getString("output"))
    }

    @Test
    fun boundsCommandOutputBeforePipesAndRedirection() = runBlocking {
        val content = "x".repeat(700_000)
        fileSystem.writeText("/home/android/a.txt", content)
        fileSystem.writeText("/home/android/b.txt", content)

        val direct = shell.execute(JSONObject().put("input", "cat a.txt b.txt"))
        assertEquals("completed", direct.getString("status"))
        assertTrue(direct.getBoolean("truncated"))
        assertEquals(1024 * 1024, direct.getString("output").length)

        val redirected = shell.execute(JSONObject().put("input", "cat a.txt b.txt > combined.txt"))
        assertEquals("failed", redirected.getString("status"))
        assertTrue(redirected.getString("error").contains("output exceeds"))
        val combinedExists = try {
            fileSystem.stat("/home/android/combined.txt")
            true
        } catch (_: Exception) {
            false
        }
        assertFalse(combinedExists)
    }

    @Test
    fun appendRefusesToSilentlyReplaceBinaryFiles() = runBlocking {
        val expected = byteArrayOf(0, 1, 2, 3)
        fileSystem.write(
            "/home/android/value.data",
            ByteArrayInputStream(expected),
            expected.size.toLong(),
            "application/octet-stream",
        )

        val result = shell.execute(JSONObject().put("input", "echo changed >> value.data"))

        assertEquals("failed", result.getString("status"))
        val actual = fileSystem.open("/home/android/value.data").use { handle ->
            handle.open().use { it.readBytes() }
        }
        assertTrue(expected.contentEquals(actual))
    }

    private suspend fun readText(path: String): String = fileSystem.open(path).use { handle ->
        handle.open().use { it.readBytes().toString(Charsets.UTF_8) }
    }
}
