package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TargetNetHandlerTest {
    private lateinit var root: File
    private lateinit var server: MockWebServer
    private lateinit var handler: TargetNetHandler

    @Before
    fun setUp() {
        root = Files.createTempDirectory("gsv-android-net-").toFile()
        server = MockWebServer()
        server.start()
        handler = TargetNetHandler(root)
    }

    @After
    fun tearDown() {
        server.shutdown()
        root.deleteRecursively()
    }

    @Test
    fun returnsStatusHeadersAndAnExactResponseBody() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setHeader("Content-Type", "text/plain")
                .setHeader("X-Test", "yes")
                .setBody("from phone network"),
        )

        val response = handler.handle(
            JSONObject().put("url", server.url("/context").toString()),
            null,
        ) as TargetHandlerResponse.Body

        assertTrue(response.data.getBoolean("ok"))
        assertEquals(201, response.data.getInt("status"))
        assertEquals("yes", response.data.getJSONObject("headers").getString("x-test"))
        assertEquals("from phone network", response.body.use { it.open().use(InputStream::readBytes) }.toString(Charsets.UTF_8))
    }

    @Test
    fun streamsAnExactRequestBody() = runBlocking {
        server.enqueue(MockResponse().setBody("accepted"))
        val requestBody = ByteRequestBody("phone upload".toByteArray())

        val response = handler.handle(
            JSONObject()
                .put("url", server.url("/upload").toString())
                .put("method", "POST")
                .put("headers", JSONObject().put("Content-Type", "text/plain")),
            requestBody,
        ) as TargetHandlerResponse.Body

        response.body.close()
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("phone upload", request.body.readUtf8())
        assertTrue(requestBody.opened)
    }

    @Test
    fun rejectsBodiesForGetBeforeOpeningThem() = runBlocking {
        val requestBody = ByteRequestBody("no".toByteArray())

        val error = runCatching {
            handler.handle(JSONObject().put("url", server.url("/").toString()), requestBody)
        }.exceptionOrNull()

        assertTrue(error is TargetFsException)
        assertFalse(requestBody.opened)
        assertEquals("GET requests cannot carry a body", requestBody.cancelled)
    }

    @Test
    fun rejectsNonObjectHeadersAtTheProtocolBoundary() = runBlocking {
        val error = runCatching {
            handler.handle(
                JSONObject()
                    .put("url", server.url("/").toString())
                    .put("headers", "not-an-object"),
                null,
            )
        }.exceptionOrNull()

        assertTrue(error is TargetFsException)
        assertEquals("net.fetch headers must be an object", error?.message)
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
