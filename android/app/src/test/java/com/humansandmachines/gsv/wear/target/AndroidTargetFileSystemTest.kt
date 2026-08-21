package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AndroidTargetFileSystemTest {
    private lateinit var root: File
    private lateinit var fileSystem: AndroidTargetFileSystem

    @Before
    fun setUp() {
        root = Files.createTempDirectory("gsv-android-fs-").toFile()
        fileSystem = AndroidTargetFileSystem(
            persistentRoot = File(root, "home"),
            temporaryRoot = File(root, "tmp"),
            runtime = TargetTestRuntime(
                content = mapOf(
                    "/proc/example.json" to (
                        "{\"source\":\"runtime\"}\n".toByteArray() to "application/json; charset=utf-8"
                    ),
                ),
                directories = setOf("/proc"),
            ),
        )
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun mergesRuntimeFilesWithPersistentAndTemporaryStorage() = runBlocking {
        fileSystem.writeText("~/notes/first.txt", "first\n")
        fileSystem.writeText("/tmp/second.txt", "second\n")

        assertEquals("first\n", readText("/home/android/notes/first.txt"))
        assertEquals("second\n", readText("/tmp/second.txt"))
        assertEquals("{\"source\":\"runtime\"}\n", readText("/proc/example.json"))
        assertEquals(listOf("home", "proc", "tmp"), fileSystem.list("/").directories)
        assertEquals(listOf("example.json"), fileSystem.list("/proc").files)
    }

    @Test
    fun copyMoveSearchAndDeleteShareOneVirtualNamespace() = runBlocking {
        fileSystem.writeText("/home/android/notes/a.txt", "alpha\nneedle here\n")
        fileSystem.copy("/home/android/notes/a.txt", "/tmp/copied.txt")
        val moved = fileSystem.move("/tmp/copied.txt", "/home/android/archive/b.txt")

        assertEquals("/home/android/archive/b.txt", moved.path)
        assertEquals("alpha\nneedle here\n", readText(moved.path))
        val search = fileSystem.search("/home/android", "needle", "*.txt")
        assertEquals(2, search.matches.size)
        assertTrue(search.matches.all { it.line == 2 })

        fileSystem.delete("/home/android/notes")
        assertThrows(TargetFsException::class.java) {
            runBlocking { fileSystem.stat("/home/android/notes/a.txt") }
        }
        Unit
    }

    @Test
    fun failedExactWritePreservesTheExistingDestination() = runBlocking {
        fileSystem.writeText("/home/android/value.txt", "original")

        assertThrows(TargetFsException::class.java) {
            runBlocking {
                fileSystem.write(
                    path = "/home/android/value.txt",
                    input = ByteArrayInputStream("replacement".toByteArray()),
                    expectedSize = 3,
                    contentType = "text/plain",
                )
            }
        }

        assertEquals("original", readText("/home/android/value.txt"))
        assertFalse(File(root, "home").walkTopDown().any { it.name.startsWith(".gsv-write-") })
    }

    @Test
    fun runtimeAndMountRootsAreReadOnly() = runBlocking {
        assertThrows(TargetFsException::class.java) {
            runBlocking { fileSystem.writeText("/proc/example.json", "changed") }
        }
        assertThrows(TargetFsException::class.java) {
            runBlocking { fileSystem.delete("/home/android") }
        }
        assertThrows(TargetFsException::class.java) {
            runBlocking { fileSystem.writeText("../../etc/passwd", "nope") }
        }
        assertTrue(fileSystem.stat("/proc/example.json").isFile)
    }

    @Test
    fun clearingTemporaryStorageDoesNotTouchPersistentFiles() = runBlocking {
        fileSystem.writeText("/home/android/keep.txt", "keep")
        fileSystem.writeText("/tmp/drop.txt", "drop")

        fileSystem.clearTemporary()

        assertEquals("keep", readText("/home/android/keep.txt"))
        assertTrue(fileSystem.list("/tmp").files.isEmpty())
    }

    @Test
    fun enforcesPerMountByteAndEntryQuotasAtomically() = runBlocking {
        val limited = AndroidTargetFileSystem(
            persistentRoot = File(root, "limited-home"),
            temporaryRoot = File(root, "limited-tmp"),
            runtime = TargetTestRuntime(),
            persistentByteLimit = 8,
            temporaryByteLimit = 8,
            entryLimit = 2,
        )
        limited.writeText("/home/android/a", "1234")
        limited.writeText("/home/android/b", "5678")

        assertThrows(TargetFsException::class.java) {
            runBlocking { limited.writeText("/home/android/c", "x") }
        }
        assertThrows(TargetFsException::class.java) {
            runBlocking { limited.writeText("/home/android/a", "12345") }
        }
        val value = limited.open("/home/android/a").use { handle ->
            handle.open().use { it.readBytes().toString(Charsets.UTF_8) }
        }
        assertEquals("1234", value)
        assertEquals(listOf("a", "b"), limited.list("/home/android").files)
    }

    private suspend fun readText(path: String): String = fileSystem.open(path).use { handle ->
        handle.open().use { input -> input.readBytes().toString(Charsets.UTF_8) }
    }
}
