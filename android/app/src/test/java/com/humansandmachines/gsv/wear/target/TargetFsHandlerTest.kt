package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TargetFsHandlerTest {
    private lateinit var root: File
    private lateinit var fileSystem: AndroidTargetFileSystem
    private lateinit var handler: TargetFsHandler

    @Before
    fun setUp() {
        root = Files.createTempDirectory("gsv-android-handler-").toFile()
        fileSystem = AndroidTargetFileSystem(
            persistentRoot = File(root, "home"),
            temporaryRoot = File(root, "tmp"),
            runtime = TargetTestRuntime(),
        )
        handler = TargetFsHandler(fileSystem)
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun writeEditSearchAndReadUseThePublicFilesystemShapes() = runBlocking {
        val write = data(
            handler.handle(
                "fs.write",
                JSONObject().put("path", "~/note.txt").put("content", "one\ntwo\nthree"),
                null,
            ),
        )
        assertTrue(write.getBoolean("ok"))
        assertEquals(13, write.getInt("size"))

        val edit = data(
            handler.handle(
                "fs.edit",
                JSONObject()
                    .put("path", "/home/android/note.txt")
                    .put("oldString", "two")
                    .put("newString", "needle"),
                null,
            ),
        )
        assertEquals(1, edit.getInt("replacements"))

        val search = data(
            handler.handle(
                "fs.search",
                JSONObject().put("path", "~").put("query", "needle").put("include", "*.txt"),
                null,
            ),
        )
        assertEquals(1, search.getInt("count"))
        assertEquals(2, search.getJSONArray("matches").getJSONObject(0).getInt("line"))

        val read = body(
            handler.handle(
                "fs.read",
                JSONObject().put("path", "~/note.txt").put("offset", 1).put("limit", 1),
                null,
            ),
        )
        assertEquals("text", read.data.getString("kind"))
        assertEquals(1, read.data.getInt("lines"))
        assertEquals("needle", read.readBytes().toString(Charsets.UTF_8))
    }

    @Test
    fun searchDefaultsToTheAndroidHomeDirectory() = runBlocking {
        fileSystem.writeText("/home/android/note.txt", "home needle")
        fileSystem.writeText("/tmp/note.txt", "temporary needle")

        val search = data(
            handler.handle(
                "fs.search",
                JSONObject().put("query", "needle"),
                null,
            ),
        )

        assertEquals(1, search.getInt("count"))
        assertEquals(
            "/home/android/note.txt",
            search.getJSONArray("matches").getJSONObject(0).getString("path"),
        )
    }

    @Test
    fun imageReadsAndTransfersPreserveBinaryBytesAndContentType() = runBlocking {
        val expected = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
        )
        fileSystem.write(
            "/tmp/image.bin",
            ByteArrayInputStream(expected),
            expected.size.toLong(),
            "image/png",
        )

        val read = body(handler.handle("fs.read", JSONObject().put("path", "/tmp/image.bin"), null))
        assertEquals("image", read.data.getString("kind"))
        assertEquals("image/png", read.data.getString("contentType"))
        assertArrayEquals(expected, read.readBytes())

        val send = body(
            handler.handle("fs.transfer.send", JSONObject().put("path", "/tmp/image.bin"), null),
        )
        assertEquals(expected.size.toLong(), send.data.getLong("size"))
        assertArrayEquals(expected, send.readBytes())
    }

    @Test
    fun transferReceiveRequiresAndConsumesAnExactBody() = runBlocking {
        val expected = ByteArray(4097) { index -> (index % 251).toByte() }
        val requestBody = ByteRequestBody(expected)

        val result = data(
            handler.handle(
                "fs.transfer.receive",
                JSONObject()
                    .put("path", "/home/android/upload.bin")
                    .put("contentType", "application/octet-stream"),
                requestBody,
            ),
        )

        assertTrue(result.getBoolean("ok"))
        assertEquals(expected.size.toLong(), result.getLong("bytesWritten"))
        assertTrue(requestBody.opened)
        val actual = fileSystem.open("/home/android/upload.bin").use { handle ->
            handle.open().use(InputStream::readBytes)
        }
        assertArrayEquals(expected, actual)
    }

    @Test
    fun nonTransferCallsRejectRequestBodies() = runBlocking {
        val requestBody = ByteRequestBody("unused".toByteArray())

        val result = data(
            handler.handle(
                "fs.write",
                JSONObject().put("path", "/tmp/value").put("content", "value"),
                requestBody,
            ),
        )

        assertFalse(result.getBoolean("ok"))
        assertEquals("Request body is unsupported", result.getString("error"))
        assertEquals("Request body is unsupported", requestBody.cancelled)
        assertFalse(requestBody.opened)
    }

    private fun data(response: TargetHandlerResponse): JSONObject =
        (response as TargetHandlerResponse.Data).data

    private fun body(response: TargetHandlerResponse): ReadBody {
        val value = response as TargetHandlerResponse.Body
        return ReadBody(value.data, value.body)
    }

    private data class ReadBody(val data: JSONObject, val handle: TargetReadHandle) {
        fun readBytes(): ByteArray = handle.use { body -> body.open().use(InputStream::readBytes) }
    }

    private class ByteRequestBody(private val bytes: ByteArray) : TargetRequestBody {
        override val length: Long = bytes.size.toLong()
        var opened = false
        var cancelled: String? = null

        override suspend fun open(): InputStream {
            opened = true
            return ByteArrayInputStream(bytes)
        }

        override fun cancel(reason: String) {
            cancelled = reason
        }

        override fun close() = Unit
    }
}
